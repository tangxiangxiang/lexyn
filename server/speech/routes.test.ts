import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mockSpeechResponse, silentMp3 } from '../../e2e/mock-speech.ts'
import { defaultSpeechVoice } from '../../shared/contracts/speech.ts'
import { stableJson } from '../../shared/contracts/json.ts'
import { createApp } from '../app.ts'
import { initializeOwner } from '../auth/owner.ts'
import { openDatabase } from '../db/database.ts'
import { speechIdentity, speechRateLimit } from './assets.ts'
import { speechMasterKeyFile } from './credentials.ts'
import { synthesisRequest } from './provider.ts'

const origin = 'http://127.0.0.1:3000'
const password = 'test-owner-password'
const key = 'server-only-test-key'
const upstream = vi.fn<typeof fetch>(async () => mockSpeechResponse())
let dir: string
let db: ReturnType<typeof openDatabase>
let app: ReturnType<typeof createApp>
let auth: Record<string, string>

function makeApp() {
  return createApp(db, undefined, origin, Date.now, undefined, { dataDir: dir, fetch: upstream })
}
beforeEach(async () => {
  upstream.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'lexyn-speech-test-'))
  db = openDatabase(dir)
  await initializeOwner(db, 'test-admin', password)
  app = makeApp()
  const login = await app.request('/api/auth/login', {
    method: 'POST', headers: { 'X-Lexyn-Client': '1', 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'test-admin', password }),
  })
  const { session } = await login.json()
  auth = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId, Cookie: login.headers.get('Set-Cookie')!.split(';')[0] }
  expect((await speech('settings', { voiceId: defaultSpeechVoice, playbackRate: 1, apiKey: key }, 'PUT')).status).toBe(200)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function speech(path: string, body?: object, method = body ? 'POST' : 'GET', headers = auth) {
  return app.request('/api/speech/' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: body && JSON.stringify(body) })
}
async function write(path: string, args: unknown[]) {
  const result = await app.request('/api/library/' + path, {
    method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(args),
  })
  expect(result.status).toBe(200)
  return (await result.json()).data
}
async function makeWord(term = 'US', pronunciationOverride?: string) {
  const deck = await write('create-deck', [{ name: randomUUID() }])
  return write('create-entry', [deck.id, { term, pronunciationOverride }])
}
async function prepare(entryId: string) {
  const response = await speech('prepare', { entryId })
  expect(response.status).toBe(200)
  return await response.json()
}

test('deduplicates concurrent requests across decks, persists metadata and reuses after restart without a key', async () => {
  const first = await makeWord()
  const duplicate = await makeWord()
  const [one, two] = await Promise.all([prepare(first.id), prepare(duplicate.id)])
  expect(one).toEqual(two)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(readdirSync(join(dir, 'media', 'tts'))).toEqual([one.audioId + '.mp3'])
  expect(db.prepare('SELECT cache_key, byte_size FROM speech_assets').all()).toEqual([
    { cache_key: one.audioId, byte_size: silentMp3().length },
  ])
  await write('remove-entry', [first.deckId, first.id, true, first.revision])
  expect((await speech('prepare', { entryId: first.id })).status).toBe(404)
  await speech('settings', { voiceId: defaultSpeechVoice, playbackRate: 1, clearKey: true }, 'PUT')
  db.close()
  db = openDatabase(dir)
  app = makeApp()
  expect(await prepare(duplicate.id)).toEqual(one)
  expect(upstream).toHaveBeenCalledTimes(1)
  const audio = await speech('audio/' + one.audioId)
  expect(audio.headers.get('Content-Type')).toBe('audio/mpeg')
  expect(audio.headers.get('Cache-Control')).toBe('private, no-store')
  expect(audio.headers.get('Content-Length')).toBe(String(silentMp3().length))
  expect(Buffer.from(await audio.arrayBuffer())).toEqual(silentMp3())
  const uncached = await makeWord('us')
  const unavailable = await speech('prepare', { entryId: uncached.id })
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toMatchObject({ error: { code: 'TTS_NOT_CONFIGURED' } })
})

test('rebuilds a corrupted, absent or symlinked file and rejects arbitrary paths', async () => {
  const entry = await makeWord()
  const result = await prepare(entry.id)
  const path = join(dir, 'media', 'tts', result.audioId + '.mp3')
  const corrupted = silentMp3()
  corrupted[900] = 1 // Keep the size and header but change the checksum.
  writeFileSync(path, corrupted)
  expect((await speech('audio/' + result.audioId)).status).toBe(404)
  expect(await prepare(entry.id)).toEqual(result)
  unlinkSync(path)
  expect(await prepare(entry.id)).toEqual(result)
  unlinkSync(path)
  symlinkSync(join(dir, 'lexyn.sqlite'), path)
  expect((await speech('audio/' + result.audioId)).status).toBe(404)
  expect(await prepare(entry.id)).toEqual(result)
  expect(upstream).toHaveBeenCalledTimes(4)
  expect((await speech('audio/..%2F..%2Flexyn.sqlite')).status).toBe(404)
})

test('validates authentication, origin, input and library eligibility without disclosing credentials', async () => {
  const word = await makeWord()
  const { audioId } = await prepare(word.id)
  expect((await speech('audio/' + audioId, undefined, 'GET', { 'X-Lexyn-Client': '1' })).status).toBe(401)
  expect((await speech('prepare', { entryId: word.id }, 'POST', { ...auth, Origin: 'https://other.invalid' })).status).toBe(403)
  expect((await speech('prepare', { entryId: 'bad-id' })).status).toBe(400)
  expect((await speech('prepare', { entryId: word.id, text: 'arbitrary speech' })).status).toBe(400)
  expect((await speech('preview', { voiceId: 'toString' })).status).toBe(400)
  expect((await speech('settings', { voiceId: defaultSpeechVoice, playbackRate: 2 }, 'PUT')).status).toBe(400)
  expect(await (await speech('settings')).text()).not.toContain(key)
  await write('archive-deck', [word.deckId, true, 1])
  expect((await speech('prepare', { entryId: word.id })).status).toBe(404)
  expect(upstream).toHaveBeenCalledTimes(1)
})

test('keys voice, actual case and model independently of playback rate and text source', async () => {
  const word = await makeWord('US')
  const lower = await makeWord('us')
  const first = await prepare(word.id)
  expect((await prepare(lower.id)).audioId).not.toBe(first.audioId)
  await write('update-entry', [word.deckId, word.id, { term: 'US', pronunciationOverride: 'U S' }, word.revision])
  const { body } = db.prepare('SELECT body FROM entries WHERE id = ?').get(word.id) as { body: string }
  const updated = JSON.parse(body)
  expect(updated).toMatchObject({ term: 'US', normalizedTerm: 'us', pronunciationOverride: 'U S' })
  const overridden = await prepare(word.id)
  expect(overridden.audioId).not.toBe(first.audioId)
  expect(JSON.parse(String(upstream.mock.lastCall?.[1]?.body)).text).toBe('U S')
  expect(await prepare((await makeWord('U S')).id)).toEqual(overridden)
  expect(await prepare((await makeWord('Different spelling', 'US')).id)).toEqual(first)
  await speech('settings', { voiceId: defaultSpeechVoice, playbackRate: 0.8 }, 'PUT')
  expect(await prepare(word.id)).toEqual({ ...overridden, playbackRate: 0.8 })
  expect(upstream).toHaveBeenCalledTimes(3)
  await speech('settings', { voiceId: 'English_PatientMan', playbackRate: 0.8 }, 'PUT')
  expect((await prepare(word.id)).audioId).not.toBe(overridden.audioId)
  expect(upstream).toHaveBeenCalledTimes(4)
  expect(speechIdentity(synthesisRequest('US', defaultSpeechVoice, 'other-model')).id).not.toBe(first.audioId)
})

test('does not serve a file from a failed index write and allows a retry', async () => {
  const word = await makeWord()
  const { id } = speechIdentity(synthesisRequest(word.term, defaultSpeechVoice))
  db.exec("CREATE TRIGGER reject_asset BEFORE INSERT ON speech_assets BEGIN SELECT RAISE(FAIL, 'test'); END")
  expect((await speech('prepare', { entryId: word.id })).status).toBe(500)
  expect((await speech('audio/' + id)).status).toBe(404)
  expect(readdirSync(join(dir, 'media', 'tts'))).toEqual([id + '.mp3'])
  db.exec('DROP TRIGGER reject_asset')
  expect((await prepare(word.id)).audioId).toBe(id)
  expect((await speech('audio/' + id)).status).toBe(200)
})

test('reuses an indexed Phase 7B MP3 regardless of where the same synthesis text came from', async () => {
  const first = await makeWord('USA', 'U S')
  const actual = await prepare(first.id)
  const request = synthesisRequest('U S', defaultSpeechVoice)
  const parameters = stableJson({ provider: 'minimax', version: 1, request, override: 'U S' })
  const legacy = createHash('sha256').update(parameters).digest('hex')
  const audioDir = join(dir, 'media', 'tts')
  renameSync(join(audioDir, actual.audioId + '.mp3'), join(audioDir, legacy + '.mp3'))
  db.prepare('UPDATE speech_assets SET cache_key = ?, parameters = ? WHERE cache_key = ?')
    .run(legacy, parameters, actual.audioId)
  expect((await prepare(first.id)).audioId).toBe(legacy)
  expect((await prepare((await makeWord('U S')).id)).audioId).toBe(legacy)
  expect(upstream).toHaveBeenCalledTimes(1)
})

test('persists only ciphertext, applies rotations to new synthesis and protects a credential if the master key is lost', async () => {
  const ciphertext = () => db.prepare('SELECT ciphertext FROM speech_credentials').pluck().get() as string
  const master = join(dir, speechMasterKeyFile)
  expect(ciphertext()).not.toContain(key)
  expect(statSync(master).mode & 0o777).toBe(0o600)
  const values = { voiceId: defaultSpeechVoice, playbackRate: 1.2 }
  const first = ciphertext()
  expect((await speech('settings', values, 'PUT')).status).toBe(200)
  expect(ciphertext()).toBe(first)
  expect((await speech('settings', { ...values, apiKey: key, clearKey: true }, 'PUT')).status).toBe(400)
  const rotation = await speech('settings', { ...values, apiKey: 'replacement-key' }, 'PUT')
  expect(await rotation.json()).toEqual({ ...values, credentialStatus: 'configured' })
  const rotated = ciphertext()
  expect(rotated).not.toBe(first)
  expect(rotated).not.toContain('replacement-key')
  db.close()
  db = openDatabase(dir)
  app = makeApp()
  const cached = await makeWord()
  const asset = await prepare(cached.id)
  expect(upstream.mock.lastCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer replacement-key' })
  renameSync(master, master + '.backup')
  expect(await (await speech('settings')).json()).toEqual({ ...values, credentialStatus: 'unavailable' })
  expect(await prepare(cached.id)).toEqual(asset)
  expect((await speech('preview', { voiceId: defaultSpeechVoice })).status).toBe(503)
  expect((await speech('settings', { ...values, apiKey: 'another-key' }, 'PUT')).status).toBe(503)
  expect(ciphertext()).toBe(rotated)
  renameSync(master + '.backup', master)
  expect(await (await speech('settings')).json()).toEqual({ ...values, credentialStatus: 'configured' })
})

test('rate limit expires without growing the rolling window past its bound', () => {
  let now = 0
  const allow = speechRateLimit(2, () => now)
  allow()
  allow()
  expect(allow).toThrow(expect.objectContaining({ status: 429, retryAfter: 60 }))
  now = 60_000
  expect(allow).not.toThrow()
})
