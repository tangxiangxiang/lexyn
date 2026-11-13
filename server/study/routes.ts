import { Worker } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AuthEnv, createAuthApi } from '../auth/routes.ts'
import { fields, integer, InvalidInput, isUuid, object, validateSpellingChanges, validateTimezone } from '../../shared/contracts/validation.ts'
import { stableJson } from '../../shared/contracts/json.ts'
import { cleanDictionaryMeaning, cleanDictionaryReference, cleanPhonetics } from '../../shared/domain/dictionary.ts'
import { LibraryError, listSizes, type DeckInput, type Entry, type EntryInput } from '../../shared/domain/library.ts'
import { importFields, parseImport, previewImport, type FieldMapping, type ImportCandidate, type ImportedInput } from '../../shared/domain/library-import.ts'
import { reviewRatings } from '../../shared/domain/review.ts'
import { createReviewScheduler, schedulerConfigSnapshot, type ReviewScheduler } from '../../shared/srs/scheduler.ts'
import { createAllStudy } from './all.ts'
import { createLearnService } from './learn.ts'
import { createLibraryService } from './library.ts'
import { createReviewService } from './review.ts'
import { createStudyStore, StudyError } from './store.ts'
import { difficultWords, spellingWindow } from './spelling-stats.ts'
import { studyActivity } from './activity.ts'
import { dayBounds, weekStart } from './calendar.ts'
import { allStudyDays, minutesPerDay } from '../../shared/domain/study-plan.ts'
import { builtinWordbooks, builtinWordbookTags, type BuiltinWordbookId, type BuiltinWordbookTag } from '../../shared/domain/builtin-books.ts'
import { spellingStats, type SpellingAttempt } from '../../shared/domain/spelling.ts'
import { cefrLevels, defaultWordbookFilters, wordbookOrders, wordbookStates, type WordbookFilters } from '../../shared/contracts/wordbooks.ts'
import { installBuiltinBook, previewBuiltinBook } from './wordbooks.ts'
import type { InstallRequest, InstallResult } from './wordbook-worker.ts'
import type { Ecdict } from '../dictionary/ecdict.ts'

type Validator<T> = (value: unknown) => T
const invalid = (message = 'Invalid request arguments.'): never => { throw new InvalidInput(message) }
const id: Validator<string> = (value) => isUuid(value) ? value : invalid('Invalid identifier.')
const cardId: Validator<string> = (value) => typeof value === 'string'
  && value.startsWith('meaning-to-term:') && isUuid(value.slice(16).replace(/^word:/, '')) ? value : invalid('Invalid card identifier.')
const num = (min: number, max?: number): Validator<number> => (v) => integer(v, min, max) ? v : invalid('Invalid integer.')
const text = (max: number): Validator<string> => (v) => typeof v === 'string' && v.length <= max ? v : invalid('Invalid text.')
const bool: Validator<boolean> = (v) => typeof v === 'boolean' ? v : invalid('Expected a boolean.')
const choice = <const T extends string>(...values: T[]): Validator<T> => (v) =>
  typeof v === 'string' && values.includes(v as T) ? v as T : invalid('Invalid option.')
const optional = <T>(read: Validator<T>): Validator<T | undefined> => (v) => v == null ? undefined : read(v)
const list = <T>(read: Validator<T>, limit: number): Validator<T[]> => (v) =>
  Array.isArray(v) && v.length <= limit ? v.map(read) : invalid('Invalid list size.')
const version = num(1)
const offset = num(0)
const limit = num(1, 200)
const optId = optional(id)
const builtinWordbookId: Validator<BuiltinWordbookId> = (value) => typeof value === 'string'
  && builtinWordbooks.some(({ id }) => id === value) ? value as BuiltinWordbookId : invalid('Invalid built-in wordbook.')
const builtinWordbookTag: Validator<BuiltinWordbookTag> = (value) => typeof value === 'string'
  && builtinWordbookTags.some(({ id }) => id === value) ? value as BuiltinWordbookTag : invalid('Invalid wordbook category.')

function wordbookFilters(value: unknown): WordbookFilters {
  const row = object(value)
  fields(row, 'cefr collins states order')
  return {
    cefr: list(choice(...cefrLevels, 'unknown'), 7)(row.cefr),
    collins: list(num(1, 5), 5)(row.collins),
    states: list(choice(...wordbookStates), 3)(row.states),
    order: choice(...wordbookOrders)(row.order),
  }
}

const readBookArgs = [builtinWordbookId, list(builtinWordbookTag, builtinWordbookTags.length)] as const
const installArgs: Validators<[BuiltinWordbookId, BuiltinWordbookTag[], WordbookFilters, number, string]> = [
  ...readBookArgs, wordbookFilters, num(listSizes.min, listSizes.max), (value) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid('Refresh the wordbook preview.'),
]

function installInWorker(request: InstallRequest) {
  return new Promise<ReturnType<typeof installBuiltinBook>>((resolve, reject) => {
    const script = import.meta.url.endsWith('.ts') ? './wordbook-worker.ts' : './wordbook-worker.js'
    const worker = new Worker(new URL(script, import.meta.url), { workerData: request })
    worker.once('message', (message: InstallResult) => {
      if ('result' in message) resolve(message.result)
      else reject(new StudyError(message.message, message.status))
    })
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('Wordbook installation worker exited before returning a result.')))
  })
}

function deckInput(value: unknown): DeckInput {
  const row = object(value)
  fields(row, 'name description listSize')
  return { name: text(100)(row.name), description: optional(text(1000))(row.description),
    listSize: optional(num(listSizes.min, listSizes.max))(row.listSize) }
}
function wordFields(value: unknown, withMeaningMetadata = false) {
  const row = object(value)
  fields(row, 'term meaning explanation phonetic pronunciationOverride example note'
    + (withMeaningMetadata ? ' meaningSource meaningNeedsReview dictionaryMeaning dictionaryReference phonetics' : ''))
  return { term: text(240)(row.term), meaning: optional(text(40_000))(row.meaning),
    explanation: optional(text(200))(row.explanation),
    phonetic: optional(text(240))(row.phonetic), pronunciationOverride: optional(text(240))(row.pronunciationOverride),
    example: optional(text(4000))(row.example), note: optional(text(4000))(row.note) }
}
function entryInput(value: unknown): EntryInput {
  const row = wordFields(value, true)
  const metadata = object(value)
  const meaningSource = optional(choice('manual', 'ai', 'dictionary'))(metadata.meaningSource)
  const meaningNeedsReview = optional(bool)(metadata.meaningNeedsReview)
  if (meaningNeedsReview && meaningSource !== 'ai' && meaningSource !== 'dictionary') return invalid()
  try {
    const dictionaryMeaning = metadata.dictionaryMeaning === null ? null : cleanDictionaryMeaning(metadata.dictionaryMeaning)
    const dictionaryReference = metadata.dictionaryReference === null ? null : cleanDictionaryReference(metadata.dictionaryReference)
    const phonetics = metadata.phonetics === null ? null : cleanPhonetics(metadata.phonetics)
    return { ...row, meaning: row.meaning ?? '', meaningSource, meaningNeedsReview, dictionaryMeaning, dictionaryReference, phonetics }
  } catch { return invalid('Invalid dictionary meaning.') }
}
function importCandidate(value: unknown): ImportCandidate {
  const row = object(value)
  fields(row, 'input normalizedTerm match')
  const match = row.match === undefined ? undefined : object(row.match)
  if (match) fields(match, 'id revision')
  const rawInput = object(row.input)
  fields(rawInput, 'term meaning phonetic')
  const parsed = wordFields(rawInput)
  const input: ImportedInput = { term: parsed.term }
  if (parsed.meaning !== undefined) input.meaning = parsed.meaning
  if (parsed.phonetic !== undefined) input.phonetic = parsed.phonetic
  return { input, normalizedTerm: text(1000)(row.normalizedTerm),
    match: match && { id: id(match.id), revision: version(match.revision) } }
}
function mapping(value: unknown): FieldMapping {
  const row = object(value)
  fields(row, importFields.join(' '))
  return Object.fromEntries(Object.entries(row).map(([key, column]) => [key, num(0, 100_000)(column)]))
}
type Validators<T extends unknown[]> = { [K in keyof T]: Validator<T[K]> }
function endpoint<T extends unknown[], R>(method: 'GET' | 'POST', validators: Validators<T>, run: (...args: T) => R, write = false, optionalTail = false) {
  return {
    method, write,
    run(raw: unknown) {
      if (!Array.isArray(raw) || (raw.length !== validators.length && !(optionalTail && raw.length === validators.length - 1))) return invalid()
      const args = validators.map((read, index) => read(raw[index])) as T
      return run(...args)
    },
    // Carries the public argument tuple for the client without exporting handlers.
    types: null as unknown as { args: T; result: R },
  }
}
function endpoints(store: ReturnType<typeof createStudyStore>, engine: ReviewScheduler, clock: () => number, dictionary?: Ecdict) {
  const library = createLibraryService(store, schedulerConfigSnapshot(engine))
  const learn = createLearnService(store)
  const review = createReviewService(store, engine)
  const allStudy = createAllStudy(store, learn, review)
  const get = <T extends unknown[], R>(args: Validators<T>, run: (...args: T) => R, optionalTail = false) => endpoint('GET', args, run, false, optionalTail)
  const post = <T extends unknown[], R>(args: Validators<T>, run: (...args: T) => R, optionalTail = false) => endpoint('POST', args, run, true, optionalTail)
  return {
    'library/decks': get([offset, limit], library.listDecks),
    'library/builtin-books': get([], () => library.builtinBooks(dictionary?.wordbooks()
      ?? { installed: false, books: builtinWordbooks.map(({ id, name }) => ({ id, name, count: 0, available: false })) })),
    'library/builtin-book': get([...readBookArgs, optional(wordbookFilters), optional(offset), optional(limit)],
      (book, tags, filters, from, size) => previewBuiltinBook(store, dictionary, clock(), book, tags,
        filters ?? defaultWordbookFilters, from ?? 0, size ?? 20)),
    'library/create-builtin-book': post(installArgs, (book, tags, filters, size, selection) =>
      installBuiltinBook(store, schedulerConfigSnapshot(engine), dictionary, clock(), book, tags, filters, size, selection)),
    'library/lists': get([id], library.getLists),
    'library/list': get([id, id], library.getList),
    'library/words': get([id, offset, limit, choice('all', 'learned', 'unlearned', 'today', 'week', 'difficult'),
      choice('added', 'learned', 'alphabetical'), optId], (deckId, from, size, filter, sort, anchor) => {
      const deck = store.deck(deckId)
      if (!deck) return null
      const timezone = store.settings().timezone
      const now = clock()
      const [today] = dayBounds(now, timezone)
      const week = weekStart(now, timezone)
      const learnedAt = "json_extract(progress.body, '$.firstCompletedAt')"
      const practicedAt = "json_extract(progress.body, '$.lastPracticedAt')"
      const addedAt = "json_extract(entries.body, '$.createdAt')"
      const source = 'FROM entries LEFT JOIN word_progress AS progress ON progress.word_id=entries.word_id WHERE entries.deck_id=@deckId AND active_term IS NOT NULL'
      const totals = store.db.prepare(`SELECT count(*) AS "all", count(${learnedAt}) AS learned,
        count(CASE WHEN ${practicedAt} BETWEEN @today AND @now THEN 1 END) AS today,
        count(CASE WHEN ${practicedAt} BETWEEN @week AND @now THEN 1 END) AS week ${source}`)
        .get({ deckId, today, week, now }) as { all: number; learned: number; today: number; week: number }
      const recent = spellingWindow(now)
      const difficult = store.db.prepare(`SELECT count(*) FROM (${difficultWords})`).pluck().get({ deckId, recent, now }) as number
      const counts = { ...totals, unlearned: totals.all - totals.learned, difficult }
      const conditions = {
        all: '', learned: `AND ${learnedAt} IS NOT NULL`, unlearned: `AND ${learnedAt} IS NULL`,
        today: `AND ${practicedAt} BETWEEN @today AND @now`, week: `AND ${practicedAt} BETWEEN @week AND @now`,
      }
      const condition = filter === 'difficult' ? '' : conditions[filter]
      const scopedSource = filter === 'difficult'
        ? source.replace(' WHERE ', ` JOIN (${difficultWords}) trouble ON trouble.word_id=entries.word_id WHERE `) : source
      const date = sort === 'learned' ? learnedAt : addedAt
      const alphabetical = 'lower(active_term), active_term, entries.id'
      const order = filter === 'difficult' ? `1.0*trouble.failures/trouble.sessions DESC, trouble.failures DESC, ${alphabetical}`
        : sort === 'alphabetical' ? alphabetical : `${date} DESC, ${alphabetical}`
      const params = filter === 'today' ? { deckId, today, now } : filter === 'week' ? { deckId, week, now } : filter === 'difficult' ? { deckId, recent, now } : { deckId }
      const anchorPosition = anchor ? store.db.prepare(`
        SELECT position FROM (
          SELECT entries.id, row_number() OVER (ORDER BY ${order}) - 1 AS position ${scopedSource} ${condition}
        ) WHERE id=@anchor`).pluck().get({ ...params, anchor }) as number | undefined : undefined
      const rows = store.db.prepare(`SELECT entries.body, ${date} AS groupedAt ${scopedSource} ${condition}
        ORDER BY ${order} LIMIT @size OFFSET @from`).all({ ...params, size, from }) as { body: string; groupedAt: number | null }[]
      const entries = rows.map(({ body, groupedAt }) => ({ entry: JSON.parse(body) as Entry, groupedAt }))
      return { deck, count: counts[filter], counts, entries, timezone, anchorPosition }
    }, true),
    'library/word-detail': get([id, id], (deckId, entryId) => {
      const entry = store.entry(entryId)
      if (!entry || entry.deckId !== deckId || entry.deletedAt !== undefined) return null
      const card = store.activeCard(entry.wordId!)
      const reviews = store.db.prepare('SELECT reviewed_at FROM review_events WHERE card_id=? ORDER BY reviewed_at DESC, id DESC LIMIT 10')
        .pluck().all(card?.id ?? null) as number[]
      return { entry, reviews, nextDueAt: card?.dueAt,
        learnedAt: store.entryProgress(entryId)?.firstCompletedAt,
        spelling: spellingStats(store.all<SpellingAttempt>('SELECT body FROM spelling_attempts WHERE word_id=?', entry.wordId)
          .map((attempt) => ({ ...attempt, termChangedAt: undefined })), entry.term),
        archived: store.deck(deckId)?.archivedAt !== undefined }
    }),
    'library/rename-list': post([id, id, text(100)], library.renameList),
    'library/deck': get([id, text(240), choice('active', 'missing', 'dictionary', 'review', 'removed', 'all'), offset, limit], library.getDeck),
    'library/create-deck': post([deckInput], (input) => library.createDeck(input, clock())),
    'library/update-deck': post([id, deckInput, version], (id, input, revision) => library.updateDeck(id, input, revision, clock())),
    'library/archive-deck': post([id, bool, version], (id, archived, revision) => library.setDeckArchived(id, archived, revision, clock())),
    'library/create-entry': post([id, entryInput], (id, input) => library.createEntry(id, input, clock())),
    'library/update-entry': post([id, id, entryInput, version],
      (deck, id, input, revision) => library.updateEntry(deck, id, input, revision, clock())),
    'library/remove-entry': post([id, id, bool, version],
      (deck, id, removed, revision) => library.setEntryRemoved(deck, id, removed, revision, clock())),
    'library/import-preview': endpoint('POST', [id, text(5 * 1024 * 1024), choice('txt', 'csv'), choice('auto', 'words', 'tab'), mapping],
      (deck, source, format, mode, columns) => {
        if (!store.deck(deck)) throw new StudyError('Deck not found.', 404)
        return previewImport(parseImport(source, format, mode), columns, store.entries(deck))
      }),
    'library/import': post([id, list(importCandidate, 10_000), choice('skip', 'overwrite'), optional(num(listSizes.min, listSizes.max))],
      (deck, candidates, mode, size) => library.importEntries(deck, candidates, mode, clock(), size), true),
    'backup/library': get([optId], library.exportLibrary),
    'learn/all': post([id, choice('copy', 'dictation'), optId], (deck, mode, flow) => allStudy(deck, mode, clock(), flow), true),
    'learn/daily': get([optId, optId], (id, listId) => learn.getDailyState(id, clock(), listId), true),
    'learn/free': get([], learn.freeState),
    'learn/start-free': post([id, choice('copy', 'dictation'), optId],
      (deck, mode, listId) => learn.startFree(deck, mode, clock(), listId)),
    'learn/session': get([id], learn.getSession),
    'learn/history': get([id, offset, limit], learn.result),
    'learn/start': post([id, choice('copy', 'dictation'), list(id, 100), bool, optId],
      (deck, mode, ids, fresh, listId) => learn.startSession(deck, mode, ids, fresh, clock(), listId), true),
    'learn/mode': post([id, choice('copy', 'dictation'), version], (id, mode, revision) => learn.setMode(id, mode, revision, clock())),
    'learn/assist': post([id, id, version], (id, entry, revision) => learn.setAssisted(id, entry, revision, clock())),
    'learn/hint': post([id, id, choice('keyboard', 'syllables'), bool, version],
      (id, entry, hint, enabled, revision) => learn.setAssisted(id, entry, revision, clock(), hint, enabled)),
    'learn/status': post([id, choice('paused', 'abandoned'), version], (id, status, revision) => learn.setStatus(id, status, revision, clock())),
    'learn/resume': post([id, version], (id, revision) => learn.continueSession(id, revision, clock())),
    'learn/repair': post([id, version], (id, revision) => learn.advanceInvalid(id, revision, clock())),
    'learn/attempt': post([id, id, text(1000), version, optional(bool)], (id, entry, input, revision, partial) => {
      if (!input.length || (!input.trim() && !partial)) return invalid('Enter an answer.')
      return learn.recordAttempt(id, entry, input, revision, clock(), partial)
    }, true),
    'learn/finish': post([id, id, choice('completed', 'skipped'), version],
      (id, entry, outcome, revision) => learn.finishCurrent(id, entry, outcome, revision, clock())),
    'review/overview': get([optId, optId], (deck, list) => review.overview(deck, clock(), list), true),
    'review/session': get([optId], (deck) => review.legacyRound(deck, clock())),
    'review/scoped': get([optId, optId, optId], (deck, sessionId, list) => review.round(deck, clock(), sessionId, list), true),
    'review/start-list': post([id, id], (deck, list) => {
      if (!store.lists.get(deck, list)) throw new StudyError('List not found in this deck.', 404)
      return review.start(deck, clock(), true, undefined, list)
    }),
    'review/open': get([], review.openSession),
    'review/start': post([optId, optional(bool)], (deck, resume) => review.start(deck, clock(), resume), true),
    'review/repair': post([id, version], (id, revision) => review.repair(id, revision, clock())),
    'review/status': post([id, choice('active', 'paused', 'abandoned'), version],
      (id, status, revision) => review.setStatus(id, status, revision, clock())),
    'review/reveal': post([id, cardId, version, version],
      (id, card, entryRevision, revision) => review.reveal(id, card, entryRevision, revision, clock())),
    'review/score': post([id, cardId, choice(...reviewRatings), version],
      (id, card, rating, revision) => review.score(id, card, rating, revision, clock())),
    'progress/overview': get([], () => {
      const now = clock()
      const overview = review.overview(undefined, now)
      const activity = studyActivity(store, now)
      const spelling = store.db.prepare(`SELECT
        count(CASE WHEN json_extract(body, '$.source')='free' THEN 1 END) AS freeAttempts,
        count(CASE WHEN json_extract(body, '$.correct')=0 THEN 1 END) AS failures
        FROM spelling_attempts`).get() as { freeAttempts: number; failures: number }
      return { ...overview, streak: activity.streak, spelling, lists: store.lists.summaries() }
    }),
    'progress/activity': get([], () => studyActivity(store, clock())),
    'settings/spelling': get([], store.spellingSettings),
    'settings/save-spelling': post([validateSpellingChanges], (patch) => store.saveSpellingSettings({ ...store.spellingSettings(), ...patch })),
    'settings/owner': get([], store.settings),
    'settings/daily': post([num(1, 100)], (daily) => {
      const { timezone, studyWeekdays, reviewResetMinutes } = store.settings()
      store.saveSettings(daily, timezone, studyWeekdays, reviewResetMinutes)
    }),
    'settings/timezone': post([validateTimezone], (zone) => {
      const { dailyNewWords, studyWeekdays, reviewResetMinutes } = store.settings()
      store.saveSettings(dailyNewWords, zone, studyWeekdays, reviewResetMinutes)
    }),
    'settings/plan': post([num(1, 100), num(1, allStudyDays), num(0, minutesPerDay - 1)],
      (daily, weekdays, reset) => store.saveSettings(daily, store.settings().timezone, weekdays, reset)),
  }
}

export type StudyEndpoints = { [K in keyof ReturnType<typeof endpoints>]: ReturnType<typeof endpoints>[K]['types'] }

export function studyRoutes(db: Database.Database, auth: ReturnType<typeof createAuthApi>, clock = Date.now, dictionary?: Ecdict) {
  const app = new Hono<AuthEnv>()
  let scheduler: Promise<ReviewScheduler> | undefined
  let wordbookInstalls = Promise.resolve()
  for (const area of ['library', 'learn', 'review', 'progress', 'settings', 'backup']) {
    app.use(`/${area}/*`, auth.guardOrigin, auth.requireOwner)
    app.on(['GET', 'POST'], `/${area}/:action`, bodyLimit({ maxSize: area === 'library' ? 16 * 1024 * 1024 : 8192,
      onError: (c) => c.json({ error: { code: 'TOO_LARGE', message: 'The request is too large.' } }, 413),
    }), async (c) => {
      try {
        scheduler ??= createReviewScheduler().catch((error) => { scheduler = undefined; throw error })
        const engine = await scheduler
        const store = createStudyStore(db, c.get('ownerId'))
        const actions = endpoints(store, engine, clock, dictionary)
        const key = `${area}/${c.req.param('action')}`
        if (!Object.hasOwn(actions, key)) return c.notFound()
        const action = actions[key as keyof typeof actions]
        if (action.method !== c.req.method) return c.json({ error: { code: 'METHOD', message: 'Method not allowed.' } }, 405)
        let raw: unknown
        try {
          if (action.method === 'GET') raw = JSON.parse(c.req.query('args') ?? '[]')
          else {
            if (c.req.header('Content-Type')?.split(';')[0] !== 'application/json') return invalid('Expected JSON.')
            raw = await c.req.json()
          }
        } catch { return invalid('Expected JSON arguments.') }
        if (key === 'library/create-builtin-book' && !db.memory) {
          if (!Array.isArray(raw) || raw.length !== installArgs.length) return invalid()
          const [book, tags, filters, size, selection] = installArgs.map((read, index) => read(raw[index])) as
            [BuiltinWordbookId, BuiltinWordbookTag[], WordbookFilters, number, string]
          const request: InstallRequest = {
            path: db.name, dataDir: dictionary?.dataDir, ownerId: c.get('ownerId'),
            requestId: id(c.req.header('Idempotency-Key')), payload: stableJson([key, raw]),
            args: [clock(), book, tags, filters, size, selection], config: schedulerConfigSnapshot(engine),
          }
          const installation = wordbookInstalls.then(() => installInWorker(request))
          wordbookInstalls = installation.then(() => undefined, () => undefined)
          return c.json({ data: await installation })
        }
        const apply = () => action.run(raw)
        const result = action.write
          ? store.request(id(c.req.header('Idempotency-Key')), stableJson([key, raw]), apply)
          : db.transaction(apply)()
        return c.json({ data: result ?? null })
      } catch (error) {
        if (error instanceof StudyError || error instanceof InvalidInput || error instanceof LibraryError) {
          const status = error instanceof StudyError ? error.status : 400
          return c.json({ error: { code: status === 409 ? 'CONFLICT' : 'INVALID_REQUEST', message: error.message } }, status)
        }
        throw error
      }
    })
  }
  return app
}
