import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AuthEnv, createAuthApi } from '../auth/routes.ts'
import { fields, integer, InvalidInput, isUuid, object, validateTimezone } from '../../shared/contracts/validation.ts'
import { stableJson } from '../../shared/contracts/json.ts'
import { cleanDictionaryMeaning, cleanDictionaryReference, cleanPhonetics } from '../../shared/domain/dictionary.ts'
import { LibraryError, listSizes, type DeckInput, type Entry, type EntryInput } from '../../shared/domain/library.ts'
import { importFields, parseImport, previewImport, type FieldMapping, type ImportCandidate, type ImportedInput } from '../../shared/domain/library-import.ts'
import { reviewCardId, reviewRatings } from '../../shared/domain/review.ts'
import { createReviewScheduler, schedulerConfigSnapshot, type ReviewScheduler } from '../../shared/srs/scheduler.ts'
import { createLearnService } from './learn.ts'
import { createLibraryService } from './library.ts'
import { createReviewService } from './review.ts'
import { createStudyStore, StudyError } from './store.ts'
import { studyActivity } from './activity.ts'
import { dayBounds, weekStart } from './calendar.ts'
import { allStudyDays, minutesPerDay } from '../../shared/domain/study-plan.ts'
import { builtinWordbooks, builtinWordbookTags, type BuiltinWordbookId, type BuiltinWordbookTag } from '../../shared/domain/builtin-books.ts'
import type { Ecdict } from '../dictionary/ecdict.ts'

type Validator<T> = (value: unknown) => T
const invalid = (message = 'Invalid request arguments.'): never => { throw new InvalidInput(message) }
const id: Validator<string> = (value) => isUuid(value) ? value : invalid('Invalid identifier.')
const cardId: Validator<string> = (value) => typeof value === 'string'
  && value.startsWith('meaning-to-term:') && isUuid(value.slice(16)) ? value : invalid('Invalid card identifier.')
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
  const get = <T extends unknown[], R>(args: Validators<T>, run: (...args: T) => R, optionalTail = false) => endpoint('GET', args, run, false, optionalTail)
  const post = <T extends unknown[], R>(args: Validators<T>, run: (...args: T) => R, optionalTail = false) => endpoint('POST', args, run, true, optionalTail)
  return {
    'library/decks': get([offset, limit], library.listDecks),
    'library/builtin-books': get([], () => library.builtinBooks(dictionary?.wordbooks()
      ?? { installed: false, books: builtinWordbooks.map(({ id, name }) => ({ id, name, count: 0, available: false })) })),
    'library/builtin-book': get([builtinWordbookId, list(builtinWordbookTag, builtinWordbookTags.length)], (id, selectedTags) => {
      const catalog = dictionary?.wordbooks()
        ?? { installed: false, books: builtinWordbooks.map(({ id, name }) => ({ id, name, count: 0, available: false })) }
      const book = library.builtinBooks(catalog).books.find((candidate) => candidate.id === id)
      const detail = dictionary?.wordbookDetail(id, selectedTags) ?? {
        installed: false,
        count: 0,
        categories: builtinWordbookTags.map(({ id, name }) => ({ id, name, count: 0, selected: selectedTags.includes(id) })),
      }
      return { ...book, ...detail }
    }),
    'library/create-builtin-book': post([builtinWordbookId, list(builtinWordbookTag, builtinWordbookTags.length)], (id, selectedTags) =>
      library.createBuiltinBook(id, dictionary?.wordbookEntries(id, selectedTags), clock(), selectedTags)),
    'library/lists': get([id], library.getLists),
    'library/list': get([id, id], library.getList),
    'library/words': get([id, offset, limit, choice('all', 'learned', 'unlearned', 'today', 'week'),
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
      const source = 'FROM entries LEFT JOIN learn_progress AS progress ON progress.entry_id=entries.id WHERE entries.deck_id=@deckId AND active_term IS NOT NULL'
      const totals = store.db.prepare(`SELECT count(*) AS "all", count(${learnedAt}) AS learned,
        count(CASE WHEN ${practicedAt} BETWEEN @today AND @now THEN 1 END) AS today,
        count(CASE WHEN ${practicedAt} BETWEEN @week AND @now THEN 1 END) AS week ${source}`)
        .get({ deckId, today, week, now }) as { all: number; learned: number; today: number; week: number }
      const counts = { ...totals, unlearned: totals.all - totals.learned }
      const conditions = {
        all: '', learned: `AND ${learnedAt} IS NOT NULL`, unlearned: `AND ${learnedAt} IS NULL`,
        today: `AND ${practicedAt} BETWEEN @today AND @now`, week: `AND ${practicedAt} BETWEEN @week AND @now`,
      }
      const condition = conditions[filter]
      const date = sort === 'learned' ? learnedAt : addedAt
      const order = sort === 'alphabetical' ? 'active_term, entries.id' : `${date} DESC, active_term, entries.id`
      const params = filter === 'today' ? { deckId, today, now } : filter === 'week' ? { deckId, week, now } : { deckId }
      const anchorPosition = anchor ? store.db.prepare(`
        SELECT position FROM (
          SELECT entries.id, row_number() OVER (ORDER BY ${order}) - 1 AS position ${source} ${condition}
        ) WHERE id=@anchor`).pluck().get({ ...params, anchor }) as number | undefined : undefined
      const rows = store.db.prepare(`SELECT entries.body, ${date} AS groupedAt ${source} ${condition}
        ORDER BY ${order} LIMIT @size OFFSET @from`).all({ ...params, size, from }) as { body: string; groupedAt: number | null }[]
      const entries = rows.map(({ body, groupedAt }) => ({ entry: JSON.parse(body) as Entry, groupedAt }))
      return { deck, count: counts[filter], counts, entries, timezone, anchorPosition }
    }, true),
    'library/word-detail': get([id, id], (deckId, entryId) => {
      const entry = store.entry(entryId)
      if (!entry || entry.deckId !== deckId || entry.deletedAt !== undefined) return null
      const cardId = reviewCardId(entryId)
      const reviews = store.db.prepare('SELECT reviewed_at FROM review_events WHERE card_id=? ORDER BY reviewed_at DESC, id DESC LIMIT 10')
        .pluck().all(cardId) as number[]
      return { entry, reviews, nextDueAt: store.card(cardId)?.dueAt,
        learnedAt: store.entryProgress(entryId)?.firstCompletedAt, archived: store.deck(deckId)?.archivedAt !== undefined }
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
    'learn/daily': get([optId, optId], (id, listId) => learn.getDailyState(id, clock(), listId), true),
    'learn/session': get([id], learn.getSession),
    'learn/history': get([id, offset, limit], learn.result),
    'learn/start': post([id, choice('copy', 'dictation'), list(id, 100), bool, optId],
      (deck, mode, ids, fresh, listId) => learn.startSession(deck, mode, ids, fresh, clock(), listId), true),
    'learn/mode': post([id, choice('copy', 'dictation'), version], (id, mode, revision) => learn.setMode(id, mode, revision, clock())),
    'learn/assist': post([id, id, version], (id, entry, revision) => learn.setAssisted(id, entry, revision, clock())),
    'learn/status': post([id, choice('paused', 'abandoned'), version], (id, status, revision) => learn.setStatus(id, status, revision, clock())),
    'learn/resume': post([id, version], (id, revision) => learn.continueSession(id, revision, clock())),
    'learn/repair': post([id, version], (id, revision) => learn.advanceInvalid(id, revision, clock())),
    'learn/attempt': post([id, id, text(1000), version], (id, entry, input, revision) => {
      if (!input.trim()) return invalid('Enter an answer.')
      return learn.recordAttempt(id, entry, input, revision, clock())
    }),
    'learn/finish': post([id, id, choice('completed', 'skipped'), version],
      (id, entry, outcome, revision) => learn.finishCurrent(id, entry, outcome, revision, clock())),
    'review/overview': get([optId], (deck) => review.overview(deck, clock())),
    'review/session': get([optId], (deck) => review.round(deck, clock())),
    'review/start': post([optId], (deck) => review.start(deck, clock())),
    'review/repair': post([id, version], (id, revision) => review.repair(id, revision, clock())),
    'review/status': post([id, choice('active', 'paused', 'abandoned'), version],
      (id, status, revision) => review.setStatus(id, status, revision, clock())),
    'review/reveal': post([id, cardId, version, version],
      (id, card, entryRevision, revision) => review.reveal(id, card, entryRevision, revision, clock())),
    'review/score': post([id, cardId, choice(...reviewRatings), version],
      (id, card, rating, revision) => review.score(id, card, rating, revision, clock())),
    'progress/overview': get([], () => review.overview(undefined, clock())),
    'progress/activity': get([], () => studyActivity(store, clock())),
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
