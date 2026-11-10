import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { fields, InvalidInput, isUuid, object } from '../../shared/contracts/validation.ts'
import { defaultSpeechVoice, playbackRates, speechVoices, type SpeechSettings, type SpeechVoice } from '../../shared/contracts/speech.ts'
import { hasJsonContentType } from '../auth/csrf.ts'
import type { AuthEnv, createAuthApi } from '../auth/routes.ts'
import { createStudyStore } from '../study/store.ts'
import { createSpeechAssets, isAudioId, speechRateLimit } from './assets.ts'
import { createSpeechCredentials, maxApiKeyLength } from './credentials.ts'
import { maxSpeechText, miniMaxProvider, SpeechError, synthesisRequest } from './provider.ts'

export interface SpeechOptions {
  dataDir: string
  fetch?: typeof fetch
}
export const speechSample = 'Concurrency, architecture, and a copy-on-write queue.'
const invalid = () => new InvalidInput('Invalid speech request.')
const voiceId = (v: unknown): SpeechVoice => {
  if (typeof v !== 'string' || !Object.hasOwn(speechVoices, v)) throw invalid()
  return v as SpeechVoice
}
const missing = () => new SpeechError('TTS_NOT_FOUND', 'Pronunciation audio is unavailable.', 404)

export function speechRoutes(db: Database.Database, auth: ReturnType<typeof createAuthApi>, options?: SpeechOptions) {
  const app = new Hono<AuthEnv>()
  const credentials = createSpeechCredentials(db, options?.dataDir)
  const assets = createSpeechAssets(db, options?.dataDir)
  const limitRequests = speechRateLimit(180)
  function preferences(owner: string) {
    const row = db.prepare('SELECT voice_id AS voiceId, playback_rate AS playbackRate FROM speech_settings WHERE owner_id = ?')
      .get(owner) as Pick<SpeechSettings, 'voiceId' | 'playbackRate'> | undefined
    return { voiceId: row?.voiceId ?? defaultSpeechVoice, playbackRate: row?.playbackRate ?? 1 }
  }
  function settings(owner: string): SpeechSettings {
    return { ...preferences(owner), credentialStatus: credentials.status(owner) }
  }
  function provider(owner: string) {
    return () => {
      const key = credentials.read(owner)
      if (!key) throw new SpeechError('TTS_NOT_CONFIGURED', 'MiniMax speech is not configured on the server.', 503)
      return miniMaxProvider(key, options?.fetch)
    }
  }
  async function body(request: Request, keys: string) {
    if (!hasJsonContentType(request.headers)) throw invalid()
    const row = object(await request.json().catch(() => null))
    fields(row, keys)
    return row
  }

  app.use('*', auth.guardOrigin, auth.requireOwner, async (c, next) => {
    limitRequests()
    await next()
  })
  app.onError((error, c) => {
    if (error instanceof InvalidInput) return c.json({ error: { code: 'TTS_INVALID_INPUT', message: error.message } }, 400)
    if (error instanceof SpeechError) {
      if (error.retryAfter) c.header('Retry-After', String(error.retryAfter))
      return c.json({ error: { code: error.code, message: error.message } }, error.status)
    }
    return c.json({ error: { code: 'TTS_STORAGE', message: 'Speech audio could not be stored or read. Try again.' } }, 500)
  })
  app.use('*', bodyLimit({ maxSize: 4096, onError: (c) =>
    c.json({ error: { code: 'TTS_INVALID_INPUT', message: 'Invalid speech request.' } }, 413) }))
  app.get('/settings', (c) => c.json(settings(c.get('ownerId'))))
  app.put('/settings', async (c) => {
    const { voiceId: voice, playbackRate, apiKey, clearKey } = await body(c.req.raw, 'voiceId playbackRate apiKey clearKey')
    const id = voiceId(voice)
    if (!playbackRates.some((rate) => rate === playbackRate)) throw invalid()
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > maxApiKeyLength)) throw invalid()
    if (clearKey !== undefined && typeof clearKey !== 'boolean') throw invalid()
    const key = apiKey?.trim()
    if (key && (clearKey || !/^[\x21-\x7e]+$/.test(key))) throw invalid()
    const owner = c.get('ownerId')
    db.transaction(() => {
      if (clearKey) credentials.clear(owner)
      if (key) credentials.save(owner, key)
      db.prepare(`INSERT INTO speech_settings (owner_id, voice_id, playback_rate) VALUES (?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET voice_id = excluded.voice_id, playback_rate = excluded.playback_rate`)
        .run(owner, id, playbackRate)
    }).immediate()
    return c.json(settings(owner))
  })
  app.post('/prepare', async (c) => {
    const { entryId } = await body(c.req.raw, 'entryId')
    if (!isUuid(entryId)) throw invalid()
    const owner = c.get('ownerId')
    const store = createStudyStore(db, owner)
    const entry = store.entry(entryId)
    const deck = entry && store.deck(entry.deckId)
    if (!entry || entry.deletedAt !== undefined || !deck || deck.archivedAt !== undefined) throw missing()
    const text = entry.pronunciationOverride ?? entry.term
    if (!text.trim() || text.length > maxSpeechText || /<#/.test(text)) throw invalid()
    const { voiceId: voice, playbackRate } = preferences(owner)
    const audioId = await assets.prepare(synthesisRequest(text, voice), provider(owner), entry.pronunciationOverride)
    return c.json({ audioId, playbackRate })
  })
  app.post('/preview', async (c) => {
    const { voiceId: voice } = await body(c.req.raw, 'voiceId')
    const owner = c.get('ownerId')
    const audioId = await assets.prepare(synthesisRequest(speechSample, voiceId(voice)), provider(owner), undefined, true)
    return c.json({ audioId, playbackRate: preferences(owner).playbackRate })
  })
  app.get('/audio/:audioId', async (c) => {
    const id = c.req.param('audioId')
    if (!isAudioId(id)) throw missing()
    const bytes = await assets.read(id)
    if (!bytes) throw missing()
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    })
  })
  return app
}
