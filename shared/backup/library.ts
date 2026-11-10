import type { LibraryExport, OutboxOperation } from '../contracts/library.ts'
import { fields, integer, isUuid, object, time, validateCardState, validateOperation } from '../contracts/operation-validation.ts'
import { stableJson } from '../contracts/sync.ts'
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
  requireValid(root.format === 'lexyn-library' && root.formatVersion === 3, 'Only Lexyn library backup format v3 is supported.')
  fields(root, 'format formatVersion exportedAt metadata decks entries practiceEvents learnProgress dailyNewWords reviewCards reviewEvents schedulerConfig')
  const meta = object(root.metadata)
  fields(meta, 'librarySchemaVersion scope')
  requireValid(meta.librarySchemaVersion === 4 && (meta.scope === 'library' || meta.scope === 'deck'), 'Unsupported backup metadata.')
  requireValid(typeof root.exportedAt === 'string' && time(Date.parse(root.exportedAt)), 'Invalid export time.')
  requireValid(integer(root.dailyNewWords, 1, 100), 'Invalid daily new words limit.')
  const config = schedulerConfigSnapshot(await createReviewScheduler())
  requireValid(stableJson(root.schedulerConfig) === stableJson(config), 'Unsupported scheduler configuration.')

  const operation = (payload: Record<string, unknown>, kind: OutboxOperation['kind'], entityId: unknown, baseRevision = 0) => {
    validateOperation({ opId: payload.id, kind, entityId, payload, baseRevision, schemaVersion: 1, sequence: 1, createdAt: 0 }, config)
    return payload.id as string
  }
  const decks = rows<LibraryExport['decks'][number]>(root.decks, 'decks', (deck) => operation(deck,
    deck.archivedAt === undefined ? 'deck.update' : 'deck.archive', deck.id, Number(deck.revision) - 1))
  const deckIds = new Set(decks.map(({ id }) => id))
  requireValid(meta.scope !== 'deck' || decks.length === 1, 'A deck backup must contain exactly one deck.')
  const activeTerms = new Set<string>()
  const entries = rows<Entry>(root.entries, 'entries', (entry) => {
    const id = operation(entry, entry.deletedAt === undefined ? 'entry.update' : 'entry.delete', entry.id, Number(entry.revision) - 1)
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
    return operation(event, 'practice.create', event.entryId)
  })
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
    const { effectiveReviewedAt, ...event } = value
    requireValid(effectiveReviewedAt === undefined || (time(effectiveReviewedAt) && time(event.reviewedAt)
      && effectiveReviewedAt <= event.reviewedAt), 'Invalid effective review time.')
    return operation(event, 'review.create', event.cardId)
  })
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
    await rebuildCardFromEvents(history, (event, schedulerState) => {
      const reviewedAt = event.effectiveReviewedAt ?? event.reviewedAt
      if (++revision === 1) createdAt = reviewedAt
      const { dueAt, scheduleStatus } = schedulerState
      if (revision === history.length) {
        requireValid(snapshot.lastEventId === event.id && snapshot.createdAt === createdAt
          && sameState(snapshot.schedulerState, schedulerState), 'A review card does not match its FSRS history. Sync the source and export again.')
      }
      reviewChanges.push({ event, card: { ...snapshot, createdAt, revision, lastEventId: event.id, schedulerState, dueAt,
        scheduleStatus, updatedAt: revision === history.length ? snapshot.updatedAt : reviewedAt } })
    })
  }
  const backup = root as unknown as LibraryExport
  return { backup, reviewChanges }
}
