import { libraryFormatVersion, type LibraryExport } from '../contracts/library.ts'
import { fields, integer, isUuid, object, time, validateCardState, validateEntity, validateEvent, validateTimezone } from '../contracts/validation.ts'
import { stableJson } from '../contracts/json.ts'
import type { LearnProgress } from '../domain/learning.ts'
import type { Entry } from '../domain/library.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewCard, type ReviewCardState, type ReviewEvent } from '../domain/review.ts'
import { createReviewScheduler, rebuildCardFromEvents, schedulerConfigSnapshot } from '../srs/scheduler.ts'

export const MAX_LIBRARY_BACKUP_BYTES = 64 * 1024 * 1024

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function rows<T>(value: unknown, label: string, identify: (record: Record<string, unknown>) => string): T[] {
  requireValid(Array.isArray(value), `Invalid ${label} list.`)
  const ids = new Set<string>()
  for (const row of value) {
    const id = identify(object(row))
    requireValid(!ids.has(id), `Duplicate ID in ${label}.`)
    ids.add(id)
  }
  return value as T[]
}

function uniqueSlots<T>(events: T[], key: (event: T) => string, message: string) {
  requireValid(new Set(events.map(key)).size === events.length, message)
}

function sameState(snapshot: ReviewCardState, replay: ReviewCardState) {
  // Different JS engines may round the FSRS floating point fields differently.
  const { stability, stabilityFast, difficulty, scheduledDays, ...exact } = snapshot
  const { stability: s, stabilityFast: sf, difficulty: d, scheduledDays: days, ...expected } = replay
  return stableJson(exact) === stableJson(expected) && [[stability, s], [stabilityFast, sf], [difficulty, d], [scheduledDays, days]]
    .every(([left, right]) => Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(right)))
}

export interface LibraryRestorePlan {
  backup: LibraryExport
  reviewChanges: { event: ReviewEvent; card: ReviewCard }[]
}

export async function prepareLibraryRestore(text: string): Promise<LibraryRestorePlan> {
  requireValid(new TextEncoder().encode(text).byteLength <= MAX_LIBRARY_BACKUP_BYTES, 'The backup exceeds 64 MiB.')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('The file is not valid JSON.') }
  const root = object(raw)
  const version = root.formatVersion
  requireValid(root.format === 'lexyn-library' && (version === 4 || version === libraryFormatVersion),
    'Only Lexyn library backup formats v4 and v5 are supported.')
  fields(root, 'format formatVersion exportedAt metadata decks entries practiceEvents learnProgress settings reviewCards reviewEvents schedulerConfig')
  const meta = object(root.metadata)
  fields(meta, 'scope')
  requireValid(meta.scope === 'library' || meta.scope === 'deck', 'Unsupported backup metadata.')
  requireValid(typeof root.exportedAt === 'string' && time(Date.parse(root.exportedAt)), 'Invalid export time.')
  const settings = object(root.settings)
  fields(settings, 'dailyNewWords timezone')
  requireValid(integer(settings.dailyNewWords, 1, 100), 'Invalid daily new words limit.')
  validateTimezone(settings.timezone)
  const config = schedulerConfigSnapshot(await createReviewScheduler())
  requireValid(stableJson(root.schedulerConfig) === stableJson(config), 'Unsupported scheduler configuration.')

  const decks = rows<LibraryExport['decks'][number]>(root.decks, 'decks', (deck) => validateEntity(deck, 'deck'))
  const deckIds = new Set(decks.map(({ id }) => id))
  requireValid(meta.scope !== 'deck' || decks.length === 1, 'A deck backup must contain exactly one deck.')
  const activeTerms = new Set<string>()
  const entries = rows<Entry>(root.entries, 'entries', (entry) => {
    requireValid(version !== 4 || entry.dictionaryMeaning === undefined, 'Full dictionary meanings require backup format v5.')
    const id = validateEntity(entry, 'entry')
    requireValid(deckIds.has(entry.deckId as string), 'An entry refers to a missing deck.')
    if (entry.deletedAt === undefined) {
      const key = `${entry.deckId}:${entry.normalizedTerm}`
      requireValid(!activeTerms.has(key), 'Duplicate active spelling in a deck.')
      activeTerms.add(key)
    }
    return id
  })
  const entryDecks = new Map(entries.map(({ id, deckId }) => [id, deckId]))
  function checkEntry(record: Record<string, unknown>) {
    requireValid(isUuid(record.entryId) && isUuid(record.deckId) && entryDecks.get(record.entryId) === record.deckId,
      'Study history refers to a missing entry or the wrong deck.')
  }
  const practiceEvents = rows<LibraryExport['practiceEvents'][number]>(root.practiceEvents, 'practice events', (event) => {
    checkEntry(event)
    return validateEvent(event, 'practice', config)
  })
  uniqueSlots(practiceEvents, (event) => `${event.sessionId}:${event.entryId}`,
    'A Learn session has duplicate results for one entry.')
  const progressFromEvents = new Map<string, LearnProgress>()
  for (const event of practiceEvents) {
    if (event.outcome !== 'completed') continue
    const { entryId, completedAt } = event
    const previous = progressFromEvents.get(entryId)
    progressFromEvents.set(entryId, { entryId, firstCompletedAt: Math.min(previous?.firstCompletedAt ?? completedAt, completedAt),
      lastPracticedAt: Math.max(previous?.lastPracticedAt ?? completedAt, completedAt), completedCount: (previous?.completedCount ?? 0) + 1 })
  }
  const learnProgress = rows<LearnProgress>(root.learnProgress, 'learn progress', (progress) => {
    requireValid(isUuid(progress.entryId) && progressFromEvents.has(progress.entryId)
      && stableJson(progress) === stableJson(progressFromEvents.get(progress.entryId)), 'Learn progress does not match the practice history.')
    return progress.entryId
  })
  requireValid(learnProgress.length === progressFromEvents.size, 'Learn progress is incomplete.')
  const reviewEvents = rows<ReviewEvent>(root.reviewEvents, 'review events', (value) => {
    checkEntry(value)
    return validateEvent(value, 'review', config)
  })
  uniqueSlots(reviewEvents, (event) => `${event.sessionId}:${event.cardId}`,
    'A Review session has duplicate ratings for one card.')
  const reviewCards = rows<ReviewCard>(root.reviewCards, 'review cards', (card) => {
    checkEntry(card)
    fields(card, 'id entryId deckId direction revision lastEventId createdAt updatedAt schedulerConfigVersion schedulerState dueAt scheduleStatus')
    requireValid(card.id === reviewCardId(card.entryId as string) && card.direction === REVIEW_DIRECTION
      && integer(card.revision, 1) && isUuid(card.lastEventId) && time(card.createdAt) && time(card.updatedAt)
      && card.schedulerConfigVersion === config.version && time(card.dueAt), 'Invalid review card metadata.')
    validateCardState(card.schedulerState, card.id as string)
    const state = card.schedulerState as ReviewCardState
    requireValid(card.dueAt === state.dueAt && card.scheduleStatus === state.scheduleStatus, 'Invalid review card projection.')
    return card.id as string
  })
  const histories = new Map<string, ReviewEvent[]>()
  for (const event of reviewEvents) {
    const history = histories.get(event.cardId)
    if (history) history.push(event)
    else histories.set(event.cardId, [event])
  }
  requireValid(histories.size === reviewCards.length, 'Review cards and event histories are incomplete.')
  const reviewChanges: LibraryRestorePlan['reviewChanges'] = []
  for (const snapshot of reviewCards) {
    const history = histories.get(snapshot.id)
    requireValid(history?.length === snapshot.revision, 'A review history is missing events.')
    let revision = 0
    let createdAt = 0
    let previous: ReviewCardState | undefined
    await rebuildCardFromEvents(history, (event, schedulerState) => {
      const reviewedAt = event.reviewedAt
      requireValid(sameState(event.resultingCardState, schedulerState)
        && (previous ? event.previousCardState && sameState(event.previousCardState, previous) : !event.previousCardState),
      'A review event does not match its FSRS history.')
      previous = schedulerState
      if (++revision === 1) createdAt = reviewedAt
      const { dueAt, scheduleStatus } = schedulerState
      if (revision === history.length) {
        requireValid(snapshot.lastEventId === event.id && snapshot.createdAt === createdAt
          && sameState(snapshot.schedulerState, schedulerState), 'A review card does not match its FSRS history. Export a new backup from the server.')
      }
      reviewChanges.push({ event, card: { ...snapshot, createdAt, revision, lastEventId: event.id, schedulerState, dueAt,
        scheduleStatus, updatedAt: revision === history.length ? snapshot.updatedAt : reviewedAt } })
    })
  }
  const backup = root as unknown as LibraryExport
  return { backup, reviewChanges }
}
