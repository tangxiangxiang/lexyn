import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stableJson } from '../../../shared/contracts/json.ts'
import { fields, integer, InvalidInput, isUuid, object } from '../../../shared/contracts/validation.ts'
import { vocabularyTaskLimit, type VocabularyJob, type VocabularyPlan, type VocabularyStatus, type VocabularyTarget } from '../../../shared/contracts/vocabulary.ts'
import { cleanDictionaryMeaning, cleanDictionaryReference, cleanPhonetics, hasFinalMeaning, meaningFromSenses,
  type DictionaryMeaning, type DictionaryReference } from '../../../shared/domain/dictionary.ts'
import { entryLimits, type Deck, type Entry } from '../../../shared/domain/library.ts'
import type { AuthEnv, createAuthApi } from '../../auth/routes.ts'
import { createSpeechCredentials } from '../../speech/credentials.ts'
import { createStudyStore, StudyError, type StudyStore } from '../../study/store.ts'
import type { DictionaryEntry, DictionaryLookup } from '../../../shared/contracts/dictionary.ts'
import type { Ecdict } from '../../dictionary/ecdict.ts'
import { generateVocabulary, vocabularyChunkSize, VocabularyError, vocabularyModel, vocabularyPromptVersion,
  vocabularyRateLimited, type CurrentMeaningHint, type DictionaryHint } from './provider.ts'

const ttl = 24 * 60 * 60_000
const taskTimeout = 60 * 60_000
const invalid = () => new InvalidInput('Invalid vocabulary request.')
const conflict = () => new VocabularyError('AI_CONFLICT', 409, 'This word changed while its meaning was being generated. Reload and try again.')
const unavailable = () => new VocabularyError('AI_UNCONFIGURED', 503, 'Save a usable MiniMax key in Settings before generating vocabulary.')
const batchBusy = () => new VocabularyError('AI_BUSY', 429, 'A vocabulary batch is already running. Try again shortly.')
const noResult = 'MiniMax did not return a complete, usable meaning for this word.'

type StoredJob = VocabularyJob & { targets: VocabularyTarget[] }
const inProgress = (job: VocabularyJob) => job.status === 'pending' || job.status === 'running'

function id(value: unknown) {
  if (!isUuid(value)) throw invalid()
  return value
}
function inputText(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max || /[\p{Cc}]/u.test(value)) throw invalid()
  return value.trim()
}
function target(row: Record<string, unknown>): VocabularyTarget {
  if (!integer(row.revision, 1)) throw invalid()
  return { entryId: id(row.entryId), revision: row.revision }
}
function currentWord(store: StudyStore, deckId: string, row: VocabularyTarget) {
  const word = store.entry(row.entryId)
  if (word && word.deckId === deckId && word.revision === row.revision && word.deletedAt === undefined) return word
}
function activeDeck(store: StudyStore, deckId: string) {
  const deck = store.deck(deckId)
  if (!deck) throw new VocabularyError('AI_DECK', 404, 'Deck not found.')
  if (deck.archivedAt !== undefined) throw conflict()
  return deck
}
function hasFinalEntryMeaning(entry: Entry) {
  return hasFinalMeaning(entry.dictionaryMeaning)
}
function hasAiMeaning(entry: Entry) {
  return entry.meaningSource === 'ai' && hasFinalEntryMeaning(entry)
}
function exactDictionaryEntry(lookup?: DictionaryLookup): DictionaryEntry | undefined {
  return lookup?.found && (lookup.match === 'exact' || lookup.match === 'casefold') && lookup.entries.length === 1
    ? lookup.entries[0] : undefined
}
function referenceFromLookup(word: Entry, lookup?: DictionaryLookup): DictionaryReference | undefined {
  if (word.dictionaryReference) return word.dictionaryReference
  const row = exactDictionaryEntry(lookup)
  const legacy = word.dictionaryMeaning
  if (legacy?.sourceWord && legacy.rawTranslation !== undefined) {
    return { sourceWord: legacy.sourceWord, sourceRevision: legacy.sourceRevision,
      translation: legacy.rawTranslation, definition: row?.definition ?? '', partOfSpeech: row?.pos ?? '', phonetic: row?.phonetic ?? '' }
  }
  if (!row) return
  return { sourceWord: row.word, sourceRevision: row.dictionaryMeaning?.sourceRevision,
    translation: row.translation, definition: row.definition, partOfSpeech: row.pos, phonetic: row.phonetic }
}
function currentMeaningHint(word: Entry): CurrentMeaningHint | null {
  if (!word.meaning.trim()) return null
  const finalSenses = word.dictionaryMeaning?.senses.filter((sense) => sense.source !== 'ecdict') ?? []
  return { text: word.meaning, senses: finalSenses.map(({ partOfSpeech, definitions, domain }) => ({ partOfSpeech, definitions, domain })) }
}
function phoneticValues(word: Entry, reference?: DictionaryReference) {
  const current = word.phonetics ?? {}
  const unspecified = current.unspecified?.trim() || word.phonetic?.trim() || reference?.phonetic.trim()
  const alreadyClassified = unspecified && [current.british, current.american].some((value) => value?.trim() === unspecified)
  return cleanPhonetics({ ...current, ...(!current.unspecified && unspecified && !alreadyClassified ? { unspecified } : {}) })
}
function dictionaryHint(reference?: DictionaryReference): DictionaryHint | null {
  return reference ? { ...reference, pos: reference.partOfSpeech } : null
}
function normalizedMeaning(value: DictionaryMeaning | undefined) {
  return value?.senses.filter(({ definitions }) => definitions.length)
}

export function vocabularyRoutes(db: Database.Database, auth: ReturnType<typeof createAuthApi>, dataDir?: string,
  send?: typeof fetch, dictionary?: Ecdict) {
  const app = new Hono<AuthEnv>()
  const credentials = createSpeechCredentials(db, dataDir)
  const requestTimes: number[] = []
  let pendingCalls = 0
  let active: { id: string; controller: AbortController } | undefined
  let lastAccess: { keyHash: string; status: 'available' | 'auth' | 'quota' } | undefined
  const singleflight = new Map<string, Promise<Entry>>()
  const autoTasks = new Map<string, { status: 'running' | 'completed' | 'failed'; updatedAt: number; error?: string }>()
  const storeFor = (owner: string) => createStudyStore(db, owner)
  const autoKey = (owner: string, entryId: string, revision: number) => `${owner}:${entryId}:${revision}`

  function readJob(owner: string, deckId: string): StoredJob | undefined {
    const body = db.prepare('SELECT body FROM vocabulary_jobs WHERE owner_id = ? AND deck_id = ? AND expires_at > ?')
      .pluck().get(owner, deckId, Date.now()) as string | undefined
    const job = body ? JSON.parse(body) as StoredJob : undefined
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

  async function call(key: string, deck: Deck, terms: string[], hint: string | undefined,
    signal: AbortSignal | undefined, currentMeanings: (CurrentMeaningHint | null)[], dictionaryHints: (DictionaryHint | null)[]) {
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
      const result = await generateVocabulary(key, terms, { name: deck.name, description: deck.description, hint,
        currentMeanings, dictionaryHints }, send, undefined, signal)
      lastAccess = { keyHash: hash, status: 'available' }
      return result
    } catch (error) {
      if (!signal?.aborted && error instanceof VocabularyError && (error.code === 'AI_AUTH' || error.code === 'AI_QUOTA')) {
        lastAccess = { keyHash: hash, status: error.code === 'AI_AUTH' ? 'auth' : 'quota' }
      }
      throw error
    } finally { pendingCalls-- }
  }

  async function generateAndSave(owner: string, entryId: string, expectedRevision: number, hint?: string, signal?: AbortSignal) {
    const store = storeFor(owner)
    const word = store.entry(entryId)
    if (!word || word.deletedAt !== undefined || word.revision !== expectedRevision) throw conflict()
    const deck = activeDeck(store, word.deckId)
    const key = checkedKey(owner)
    const lookup = dictionary?.lookup(word.term)
    const reference = referenceFromLookup(word, lookup)
    const fingerprint = stableJson([owner, keyHash(key), deck.id, deck.revision, word.id, word.revision,
      word.term, word.meaning, word.dictionaryMeaning?.senses ?? [], reference, hint ?? '', vocabularyModel, vocabularyPromptVersion])
    const existing = singleflight.get(fingerprint)
    if (existing) return existing
    const task = (async () => {
      const [candidate] = await call(key, deck, [word.term], hint, signal,
        [currentMeaningHint(word)], [dictionaryHint(reference)])
      if (!candidate || !candidate.senses.length) throw new VocabularyError('AI_OUTPUT', 502, candidate?.warning || noResult)
      const meaning = meaningFromSenses(candidate.senses)
      if (!meaning || meaning.length > entryLimits.meaning) throw new VocabularyError('AI_OUTPUT', 502, noResult)
      return db.transaction(() => {
        const current = store.entry(entryId)
        if (!current || current.deletedAt !== undefined || current.deckId !== deck.id || current.revision !== expectedRevision
          || current.term !== word.term || store.deck(deck.id)?.archivedAt !== undefined) throw conflict()
        const existingMeaning = current.dictionaryMeaning
        const dictionaryMeaning = cleanDictionaryMeaning({
          ...(existingMeaning?.sourceWord && existingMeaning.rawTranslation !== undefined ? {
            sourceWord: existingMeaning.sourceWord, sourceRevision: existingMeaning.sourceRevision,
            rawTranslation: existingMeaning.rawTranslation, partiallyStructured: existingMeaning.partiallyStructured,
          } : reference ? { sourceWord: reference.sourceWord, sourceRevision: reference.sourceRevision,
            rawTranslation: reference.translation } : {}),
          senses: candidate.senses, model: vocabularyModel, promptVersion: vocabularyPromptVersion, optimizedAt: Date.now(),
        })
        const dictionaryReference = cleanDictionaryReference(reference ?? current.dictionaryReference)
        const phonetics = phoneticValues(current, reference)
        const updated: Entry = {
          ...current,
          dictionaryMeaning,
          dictionaryReference,
          phonetics,
          meaning,
          meaningSource: 'ai',
          meaningNeedsReview: candidate.needsReview || undefined,
          revision: current.revision + 1,
          updatedAt: Math.max(current.updatedAt, Date.now()),
        }
        store.saveEntry(updated)
        return updated
      }).immediate()
    })().finally(() => { singleflight.delete(fingerprint) })
    singleflight.set(fingerprint, task)
    return task
  }

  async function body(request: Request, keys: string) {
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw invalid()
    const row = object(await request.json().catch(() => null))
    fields(row, keys)
    return row
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
        const activeDeckNow = activeDeck(store, deck.id)
        if (checkedKey(owner) !== key) throw unavailable()
        const chunk = job.targets.slice(offset, offset + vocabularyChunkSize)
        const eligible = chunk.flatMap((row) => {
          const word = currentWord(store, deck.id, row)
          if (!word) return []
          const lookup = dictionary?.lookup(word.term)
          const reference = referenceFromLookup(word, lookup)
          return [{ row, word, lookup, reference }]
        })
        let results: Awaited<ReturnType<typeof generateVocabulary>> = []
        let problem: string | undefined
        let fatal = false
        if (eligible.length) {
          try {
            results = await call(key, activeDeckNow, eligible.map(({ word }) => word.term), undefined, signal,
              eligible.map(({ word }) => currentMeaningHint(word)), eligible.map(({ reference }) => dictionaryHint(reference)))
          } catch (error) {
            signal.throwIfAborted()
            problem = error instanceof VocabularyError ? error.message : 'Vocabulary generation failed.'
            fatal = error instanceof VocabularyError && ['AI_AUTH', 'AI_QUOTA', 'AI_RATE_LIMIT'].includes(error.code)
          }
        }
        signal.throwIfAborted()
        const byId = new Map(eligible.map((item, index) => [item.row.entryId, { ...item, candidate: results[index] }]))
        progress = db.transaction(() => {
          const next = { ...progress, processed: progress.processed + chunk.length, updatedAt: Date.now() }
          for (const row of chunk) {
            const item = byId.get(row.entryId)
            const current = currentWord(store, deck.id, row)
            if (!item || !current) {
              next.skipped++
              next.conflicts++
              continue
            }
            if (!item.lookup?.found) next.notFound = (next.notFound ?? 0) + 1
            if (!item.candidate?.senses.length) {
              next.failed++
              next.error = problem ?? item.candidate?.warning ?? noResult
              continue
            }
            const meaning = meaningFromSenses(item.candidate.senses)
            if (!meaning || meaning.length > entryLimits.meaning) {
              next.failed++
              next.error = noResult
              continue
            }
            const old = current.dictionaryMeaning
            const dictionaryMeaning = cleanDictionaryMeaning({
              ...(old?.sourceWord && old.rawTranslation !== undefined ? {
                sourceWord: old.sourceWord, sourceRevision: old.sourceRevision, rawTranslation: old.rawTranslation,
                partiallyStructured: old.partiallyStructured,
              } : item.reference ? { sourceWord: item.reference.sourceWord, sourceRevision: item.reference.sourceRevision,
                rawTranslation: item.reference.translation } : {}),
              senses: item.candidate.senses, model: vocabularyModel, promptVersion: vocabularyPromptVersion, optimizedAt: Date.now(),
            })
            const phonetics = phoneticValues(current, item.reference)
            const updated: Entry = { ...current, dictionaryMeaning, dictionaryReference: item.reference ?? current.dictionaryReference,
              phonetics, meaning, meaningSource: 'ai', meaningNeedsReview: item.candidate.needsReview || undefined,
              revision: current.revision + 1, updatedAt: Math.max(current.updatedAt, Date.now()) }
            store.saveEntry(updated)
            next.succeeded++
            next.aiSaved = (next.aiSaved ?? 0) + 1
            if (item.lookup?.found) next.dictionarySaved = (next.dictionarySaved ?? 0) + 1
            if (item.candidate.needsReview) next.needsReview++
          }
          next.error = problem ?? next.error
          saveJob(owner, next)
          return next
        }).immediate()
        if (fatal) { finish('failed', problem); return }
      }
      finish('completed', progress.error)
    } catch (error) {
      if (controller.signal.aborted) return
      const message = signal.aborted ? 'Vocabulary task reached its time limit.'
        : error instanceof VocabularyError ? error.message : 'Vocabulary generation failed.'
      try { finish('failed', message) } catch { /* The saved job is reported as interrupted after a server restart. */ }
    }
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

  app.post('/auto/:entryId', async (c) => {
    const raw = await body(c.req.raw, 'revision')
    if (!integer(raw.revision, 1)) throw invalid()
    const owner = c.get('ownerId')
    const entryId = id(c.req.param('entryId'))
    const store = storeFor(owner)
    const word = store.entry(entryId)
    if (!word || word.deletedAt !== undefined || word.revision !== raw.revision) throw conflict()
    if (hasAiMeaning(word)) return c.json({ started: false, ready: true, status: 'completed' as const })
    checkedKey(owner)
    const deck = activeDeck(store, word.deckId)
    const taskKey = autoKey(owner, entryId, word.revision)
    for (const [key, task] of autoTasks) if (task.updatedAt < Date.now() - 60 * 60_000) autoTasks.delete(key)
    const existing = autoTasks.get(taskKey)
    if (existing?.status === 'running') return c.json({ started: true, ready: false, status: 'running' as const }, 202)
    autoTasks.set(taskKey, { status: 'running', updatedAt: Date.now() })
    void generateAndSave(owner, entryId, word.revision).then(() => {
      autoTasks.set(taskKey, { status: 'completed', updatedAt: Date.now() })
    }).catch((error) => {
      autoTasks.set(taskKey, { status: 'failed', updatedAt: Date.now(),
        error: error instanceof VocabularyError ? error.message : 'Vocabulary generation failed.' })
    })
    // generateAndSave singleflight prevents duplicate billing for the same saved revision.
    return c.json({ started: true, ready: false, status: 'running' as const, deckId: deck.id }, 202)
  })

  app.get('/auto/:entryId', (c) => {
    const owner = c.get('ownerId')
    const entryId = id(c.req.param('entryId'))
    const revision = Number(c.req.query('revision'))
    if (!integer(revision, 1)) throw invalid()
    const state = autoTasks.get(autoKey(owner, entryId, revision))
    if (state) return c.json(state)
    const current = storeFor(owner).entry(entryId)
    if (current && current.revision > revision && hasFinalEntryMeaning(current)) return c.json({ status: 'completed' as const })
    return c.json({ status: current?.revision === revision ? 'idle' as const : 'failed' as const })
  })

  app.post('/optimize/:entryId', async (c) => {
    const raw = await body(c.req.raw, 'revision hint')
    if (!integer(raw.revision, 1)) throw invalid()
    const expected = raw.revision
    const hint = raw.hint === undefined ? undefined : inputText(raw.hint, 240)
    const owner = c.get('ownerId')
    const entryId = id(c.req.param('entryId'))
    return c.json(await generateAndSave(owner, entryId, expected, hint))
  })

  app.get('/batch/:deckId', (c) => {
    const owner = c.get('ownerId')
    const deckId = id(c.req.param('deckId'))
    const job = readJob(owner, deckId)
    const store = storeFor(owner)
    const deck = store.deck(deckId)
    const missing = deck && deck.archivedAt === undefined
      ? store.entries(deckId).filter((entry) => entry.deletedAt === undefined && !hasFinalEntryMeaning(entry)).length : 0
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
    const targets = store.entries(deck.id).filter((entry) => entry.deletedAt === undefined && !hasFinalEntryMeaning(entry))
      .sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm) || a.id.localeCompare(b.id))
      .slice(0, raw.count).map(({ id: entryId, revision }) => ({ entryId, revision }))
    if (!targets.length) throw new VocabularyError('AI_EMPTY', 409, 'No words need a meaning.')
    const key = checkedKey(owner)
    db.prepare('DELETE FROM vocabulary_jobs WHERE expires_at <= ?').run(Date.now())
    const now = Date.now()
    const job: StoredJob = { id: requestId, deckId: deck.id, status: 'pending', targets, total: targets.length,
      processed: 0, succeeded: 0, failed: 0, skipped: 0, conflicts: 0, needsReview: 0,
      dictionarySaved: 0, aiSaved: 0, notFound: 0, createdAt: now, updatedAt: now }
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
