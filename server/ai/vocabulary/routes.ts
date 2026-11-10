import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stableJson } from '../../../shared/contracts/json.ts'
import { fields, integer, InvalidInput, isUuid, object } from '../../../shared/contracts/validation.ts'
import { vocabularyTaskLimit, vocabularyLimits, type VocabularyJob, type VocabularyPlan,
  type VocabularyStatus, type VocabularyTarget } from '../../../shared/contracts/vocabulary.ts'
import { entryLimits, type Deck, type Entry } from '../../../shared/domain/library.ts'
import type { AuthEnv, createAuthApi } from '../../auth/routes.ts'
import { createSpeechCredentials } from '../../speech/credentials.ts'
import { createStudyStore, StudyError, type StudyStore } from '../../study/store.ts'
import { generateVocabulary, vocabularyChunkSize, VocabularyError, vocabularyModel, vocabularyRateLimited } from './provider.ts'

const ttl = 24 * 60 * 60_000
const taskTimeout = 60 * 60_000
const missingEntries = "FROM entries WHERE deck_id = ? AND active_term IS NOT NULL AND json_extract(body, '$.meaning') = ''"
const invalid = () => new InvalidInput('Invalid vocabulary request.')
const conflict = () => new VocabularyError('AI_CONFLICT', 409, 'This vocabulary task or word changed. Reload and try again.')
const unavailable = () => new VocabularyError('AI_UNCONFIGURED', 503, 'Save a usable MiniMax key in Pronunciation before generating vocabulary.')
const batchBusy = () => new VocabularyError('AI_BUSY', 429, 'A vocabulary batch is already running. Try again shortly.')
const noResult = 'MiniMax did not return a valid candidate for this word.'
type StoredJob = VocabularyJob & { targets: VocabularyTarget[] }
const inProgress = (job: VocabularyJob) => job.status === 'pending' || job.status === 'running'

function id(value: unknown) {
  if (!isUuid(value)) throw invalid()
  return value
}
function target(row: Record<string, unknown>): VocabularyTarget {
  if (!integer(row.revision, 1)) throw invalid()
  return { entryId: id(row.entryId), revision: row.revision }
}
function inputText(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max || /[\p{Cc}]/u.test(value)) throw invalid()
  return value.trim()
}
function currentWord(store: StudyStore, deckId: string, row: VocabularyTarget) {
  const word = store.entry(row.entryId)
  if (word && word.deckId === deckId && word.revision === row.revision && word.deletedAt === undefined && !word.meaning.trim()) return word
}
function activeDeck(store: StudyStore, deckId: string) {
  const deck = store.deck(deckId)
  if (!deck) throw new VocabularyError('AI_DECK', 404, 'Deck not found.')
  if (deck.archivedAt !== undefined) throw conflict()
  return deck
}

export function vocabularyRoutes(db: Database.Database, auth: ReturnType<typeof createAuthApi>, dataDir?: string, send?: typeof fetch) {
  const app = new Hono<AuthEnv>()
  const credentials = createSpeechCredentials(db, dataDir)
  const requestTimes: number[] = []
  let pendingCalls = 0
  let active: { id: string; controller: AbortController } | undefined
  let lastAccess: { keyHash: string; status: 'available' | 'auth' | 'quota' } | undefined
  const singleflight = new Map<string, ReturnType<typeof generateVocabulary>>()
  const storeFor = (owner: string) => createStudyStore(db, owner)

  function readJob(owner: string, deckId: string): StoredJob | undefined {
    const body = db.prepare('SELECT body FROM vocabulary_jobs WHERE owner_id = ? AND deck_id = ? AND expires_at > ?')
      .pluck().get(owner, deckId, Date.now()) as string | undefined
    const job = body ? JSON.parse(body) as StoredJob : undefined
    // Development builds of 7C used the same table for approval drafts.
    if (!job || !Array.isArray(job.targets)) return
    if (!inProgress(job) || active?.id === job.id) return job
    const interrupted: StoredJob = { ...job, status: 'interrupted', updatedAt: Date.now() }
    saveJob(owner, interrupted)
    return interrupted
  }

  function saveJob(owner: string, job: StoredJob) {
    db.prepare(`INSERT INTO vocabulary_jobs (owner_id, deck_id, expires_at, body) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, deck_id) DO UPDATE SET expires_at = excluded.expires_at, body = excluded.body`)
      .run(owner, job.deckId, Date.now() + ttl, JSON.stringify(job))
  }

  function present({ targets: _targets, ...summary }: StoredJob): VocabularyJob { return summary }

  function checkedKey(owner: string) {
    try {
      const key = credentials.read(owner)
      if (key) return key
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'TTS_CREDENTIAL_UNAVAILABLE') throw error
    }
    throw unavailable()
  }
  const keyHash = (key: string) => createHash('sha256').update(key).digest('hex')

  async function call(key: string, deck: Deck, terms: string[], hint?: string, signal?: AbortSignal) {
    while (true) {
      signal?.throwIfAborted()
      const now = Date.now()
      while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift()
      if (pendingCalls < 2 && requestTimes.length < 12) {
        requestTimes.push(now)
        pendingCalls++
        break
      }
      if (!signal) throw vocabularyRateLimited()
      const wait = requestTimes.length >= 12 ? Math.max(1, requestTimes[0] + 60_000 - now) : 250
      await delay(wait, undefined, { signal })
    }
    const hash = keyHash(key)
    try {
      const result = await generateVocabulary(key, terms, { name: deck.name, description: deck.description, hint }, send, undefined, signal)
      lastAccess = { keyHash: hash, status: 'available' }
      return result
    } catch (error) {
      if (!signal?.aborted && error instanceof VocabularyError && (error.code === 'AI_AUTH' || error.code === 'AI_QUOTA')) {
        lastAccess = { keyHash: hash, status: error.code === 'AI_AUTH' ? 'auth' : 'quota' }
      }
      throw error
    } finally { pendingCalls-- }
  }

  async function runJob(owner: string, job: StoredJob, deck: Deck, key: string, controller: AbortController) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(taskTimeout)])
    const store = storeFor(owner)
    let progress: StoredJob = { ...job, status: 'running' }
    const finish = (status: VocabularyJob['status'], error?: string) =>
      saveJob(owner, { ...progress, status, error, updatedAt: Date.now() })

    try {
      saveJob(owner, progress)
      for (let offset = 0; offset < job.targets.length; offset += vocabularyChunkSize) {
        signal.throwIfAborted()
        const currentDeck = activeDeck(store, deck.id)
        if (checkedKey(owner) !== key) throw unavailable()
        const chunk = job.targets.slice(offset, offset + vocabularyChunkSize)
        const eligible = chunk.flatMap((row) => {
          const word = currentWord(store, deck.id, row)
          return word ? [{ row, term: word.term }] : []
        })
        let results: Awaited<ReturnType<typeof generateVocabulary>> = []
        let problem: string | undefined
        let fatal = false
        if (eligible.length) {
          try {
            results = await call(key, currentDeck, eligible.map(({ term }) => term), undefined, signal)
          } catch (error) {
            signal.throwIfAborted()
            problem = error instanceof VocabularyError ? error.message : 'Vocabulary generation failed.'
            fatal = error instanceof VocabularyError && ['AI_AUTH', 'AI_QUOTA', 'AI_RATE_LIMIT'].includes(error.code)
          }
        }
        signal.throwIfAborted()
        const candidates = new Map(eligible.map(({ row }, index) => [row.entryId, results[index]]))
        // The progress counters and all word writes for this chunk commit together.
        progress = db.transaction(() => {
          const next = { ...progress, processed: progress.processed + chunk.length, updatedAt: Date.now() }
          const stillActive = store.deck(deck.id)?.archivedAt === undefined
          for (const row of chunk) {
            const word = stillActive ? currentWord(store, deck.id, row) : undefined
            if (!word || !candidates.has(row.entryId)) {
              next.skipped++
              next.conflicts++
              continue
            }
            const candidate = candidates.get(row.entryId)
            if (!candidate) {
              next.failed++
              next.error = problem ?? noResult
              continue
            }
            store.saveEntry({
              ...word, meaning: candidate.meaning, meaningSource: 'ai',
              meaningNeedsReview: candidate.needsReview || undefined,
              explanation: word.explanation?.trim() ? word.explanation : candidate.explanation || undefined,
              example: word.example?.trim() ? word.example : candidate.example || undefined,
              revision: word.revision + 1, updatedAt: Math.max(word.updatedAt, Date.now()),
            })
            next.succeeded++
            if (candidate.needsReview) next.needsReview++
          }
          saveJob(owner, next)
          return next
        }).immediate()
        if (fatal) { finish('failed', problem); return }
      }
      finish('completed', progress.error)
    } catch (error) {
      if (controller.signal.aborted) return // The cancellation endpoint already committed the terminal state.
      const message = signal.aborted ? 'Vocabulary task reached its time limit.'
        : error instanceof VocabularyError ? error.message : 'Vocabulary generation failed.'
      try { finish('failed', message) } catch { /* If persistence is unavailable, reads report interruption once this worker exits. */ }
    }
  }

  async function body(request: Request, keys: string) {
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw invalid()
    const row = object(await request.json().catch(() => null))
    fields(row, keys)
    return row
  }

  app.use('*', auth.guardOrigin, auth.requireOwner, bodyLimit({ maxSize: 4096,
    onError: (c) => c.json({ error: { code: 'AI_INPUT', message: 'Invalid vocabulary request.' } }, 413) }))
  app.onError((error, c) => {
    if (error instanceof VocabularyError || error instanceof InvalidInput || error instanceof StudyError) {
      const status = error instanceof InvalidInput ? 400 : error.status
      if (status === 429) c.header('Retry-After', '60')
      return c.json({ error: { code: error instanceof VocabularyError ? error.code : 'AI_INPUT', message: error.message } }, status)
    }
    return c.json({ error: { code: 'AI_STORAGE', message: 'Vocabulary task could not be read or saved.' } }, 500)
  })

  app.get('/status', (c) => {
    const owner = c.get('ownerId')
    const credential = credentials.status(owner)
    let status: VocabularyStatus['status'] = credential === 'configured' ? 'unverified' : credential
    if (credential === 'configured' && lastAccess && keyHash(checkedKey(owner)) === lastAccess.keyHash) status = lastAccess.status
    return c.json({ model: vocabularyModel, status } satisfies VocabularyStatus)
  })
  app.post('/candidate', async (c) => {
    const raw = await body(c.req.raw, 'deckId entryId revision term hint')
    const owner = c.get('ownerId')
    const store = storeFor(owner)
    const deck = activeDeck(store, id(raw.deckId))
    const term = inputText(raw.term, entryLimits.term)
    if (!term) throw invalid()
    const hint = raw.hint === undefined ? undefined : inputText(raw.hint, vocabularyLimits.context)
    if (raw.entryId !== undefined || raw.revision !== undefined) {
      const selected = target(raw)
      const word = store.entry(selected.entryId)
      if (!word || word.deckId !== deck.id || word.deletedAt !== undefined || word.revision !== selected.revision) throw conflict()
    }
    const key = checkedKey(owner)
    const fingerprint = stableJson([owner, keyHash(key), deck.id, deck.revision, term, hint ?? ''])
    let task = singleflight.get(fingerprint)
    if (!task) {
      task = call(key, deck, [term], hint).finally(() => { singleflight.delete(fingerprint) })
      singleflight.set(fingerprint, task)
    }
    const [candidate] = await task
    if (!candidate) throw new VocabularyError('AI_OUTPUT', 502, noResult)
    return c.json(candidate)
  })

  app.get('/batch/:deckId', (c) => {
    const owner = c.get('ownerId')
    const deckId = id(c.req.param('deckId'))
    const job = readJob(owner, deckId)
    const deck = storeFor(owner).deck(deckId)
    const missing = deck && deck.archivedAt === undefined
      ? db.prepare('SELECT count(*) ' + missingEntries).pluck().get(deckId) as number : 0
    return c.json({ job: job ? present(job) : null, missing, limit: vocabularyTaskLimit, model: vocabularyModel } satisfies VocabularyPlan)
  })

  app.post('/batch/:deckId', async (c) => {
    const raw = await body(c.req.raw, 'requestId afterTaskId count')
    const requestId = id(raw.requestId)
    const afterTaskId = raw.afterTaskId === null ? null : id(raw.afterTaskId)
    if (!integer(raw.count, 1, vocabularyTaskLimit)) throw invalid()
    const owner = c.get('ownerId')
    const store = storeFor(owner)
    const deck = activeDeck(store, id(c.req.param('deckId')))
    const existing = readJob(owner, deck.id)
    if (existing?.id === requestId) return c.json(present(existing))
    if ((existing?.id ?? null) !== afterTaskId) throw conflict()
    if (active) throw batchBusy()
    // Read the entire eligible scope from SQLite. Limit it to the number the user confirmed.
    const targets = store.all<Entry>('SELECT body ' + missingEntries + ' ORDER BY active_term, id LIMIT ?', deck.id, raw.count)
      .map(({ id: entryId, revision }) => ({ entryId, revision }))
    if (!targets.length) throw new VocabularyError('AI_EMPTY', 409, 'No words need a meaning.')
    const key = checkedKey(owner)
    db.prepare('DELETE FROM vocabulary_jobs WHERE expires_at <= ?').run(Date.now())
    const now = Date.now()
    const job: StoredJob = { id: requestId, deckId: deck.id, status: 'pending', targets, total: targets.length,
      processed: 0, succeeded: 0, failed: 0, skipped: 0, conflicts: 0, needsReview: 0, createdAt: now, updatedAt: now }
    saveJob(owner, job)
    const controller = new AbortController()
    active = { id: job.id, controller }
    void runJob(owner, job, deck, key, controller).finally(() => { active = undefined })
    return c.json(present(job), 202)
  })

  app.post('/batch/:deckId/cancel', async (c) => {
    const { jobId } = await body(c.req.raw, 'jobId')
    const owner = c.get('ownerId')
    const job = readJob(owner, id(c.req.param('deckId')))
    if (!job || job.id !== id(jobId)) throw conflict()
    if (!inProgress(job)) return c.json(present(job))
    const cancelled: StoredJob = { ...job, status: 'cancelled', updatedAt: Date.now() }
    saveJob(owner, cancelled)
    active?.controller.abort()
    return c.json(present(cancelled))
  })
  return app
}
