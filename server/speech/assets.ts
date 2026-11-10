import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { stableJson } from '../../shared/contracts/json.ts'
import { isMp3, maxAudioBytes, SpeechError, synthesisRequest } from './provider.ts'

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
export const isAudioId = (value: string) => /^[a-f0-9]{64}$/.test(value)
type Synthesis = ReturnType<typeof synthesisRequest>
type ResolveProvider = () => (request: Synthesis) => Promise<Buffer>
type Asset = { byte_size: number; content_hash: string }

export function speechIdentity(request: Synthesis, override?: string) {
  const parameters = stableJson({ provider: 'minimax', version: 1, request, override: override ?? null })
  return { parameters, id: hash(parameters) }
}

export function speechRateLimit(max: number, clock = Date.now) {
  let times: number[] = []
  return () => {
    const now = clock()
    times = times.filter((time) => time > now - 60_000)
    if (times.length >= max) {
      const retry = Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000))
      throw new SpeechError('TTS_RATE_LIMIT', 'Too many speech requests. Try again shortly.', 429, retry)
    }
    times.push(now)
  }
}

export function createSpeechAssets(db: Database.Database, dataDir: string | undefined, clock = Date.now) {
  const directory = dataDir && join(dataDir, 'media', 'tts')
  const inFlight = new Map<string, Promise<string>>()
  let generating = 0
  const limitGeneration = speechRateLimit(20, clock)
  const limitPreview = speechRateLimit(4, clock)

  async function read(id: string) {
    if (!directory || !isAudioId(id)) return
    const asset = db.prepare('SELECT byte_size, content_hash FROM speech_assets WHERE cache_key = ?').get(id) as Asset | undefined
    if (!asset || asset.byte_size < 1 || asset.byte_size > maxAudioBytes) return
    let file
    try {
      file = await open(join(directory, id + '.mp3'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== asset.byte_size) return
      const bytes = Buffer.alloc(asset.byte_size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const audio = bytes.subarray(0, bytesRead)
      if (bytesRead === asset.byte_size && isMp3(audio) && hash(audio) === asset.content_hash) return audio
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    } finally { await file?.close() }
  }

  async function generate(id: string, parameters: string, request: Synthesis, resolveProvider: ResolveProvider, preview: boolean) {
    if (await read(id)) return id
    if (!directory) throw new SpeechError('TTS_NOT_CONFIGURED', 'MiniMax speech is not configured on the server.', 503)
    const synthesize = resolveProvider()
    if (generating >= 2) throw new SpeechError('TTS_BUSY', 'Speech generation is busy. Try again shortly.', 429, 2)
    if (preview) limitPreview()
    limitGeneration()
    generating++
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    let temporaryCreated = false
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const audio = await synthesize(request)
      if (!isMp3(audio)) throw new SpeechError('TTS_INVALID_AUDIO', 'The speech provider returned invalid audio.', 502)
      const file = await open(temporary, 'wx', 0o600)
      temporaryCreated = true
      try { await file.writeFile(audio); await file.sync() } finally { await file.close() }
      await rename(temporary, join(directory, id + '.mp3'))
      temporaryCreated = false
      // If indexing fails or the process stops here, the unindexed file
      // cannot be served. A later request can safely replace it.
      db.prepare(`INSERT INTO speech_assets (cache_key, parameters, byte_size, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET
        parameters = excluded.parameters, byte_size = excluded.byte_size, content_hash = excluded.content_hash,
        created_at = excluded.created_at`).run(id, parameters, audio.length, hash(audio), clock())
      return id
    } finally {
      generating--
      if (temporaryCreated) await unlink(temporary).catch(() => {})
    }
  }

  return {
    read,
    prepare(request: Synthesis, resolveProvider: ResolveProvider, override?: string, preview = false) {
      const { id, parameters } = speechIdentity(request, override)
      const existing = inFlight.get(id)
      if (existing) return existing
      if (inFlight.size >= 16) throw new SpeechError('TTS_BUSY', 'Speech generation is busy. Try again shortly.', 429, 2)
      // Complete and publish a bounded job even if its originating browser
      // leaves. This preserves the paid result for other callers and retries.
      const task = generate(id, parameters, request, resolveProvider, preview).finally(() => { inFlight.delete(id) })
      inFlight.set(id, task)
      return task
    },
  }
}
