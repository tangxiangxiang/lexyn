import type { OutboxOperation } from './library.ts'
import { stableJson } from './sync.ts'
import { cleanDeck, cleanEntry, LibraryError, normalizeTerm } from '../domain/library.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewCardState, type ReviewSchedulerConfig } from '../domain/review.ts'
import { isReviewRating, restoreCard } from '../srs/scheduler.ts'

export class InvalidOperation extends Error {}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidOperation('Expected an object.')
  return value as Record<string, unknown>
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function time(value: unknown) {
  return integer(value, 0, 8.64e15)
}

export function fields(record: Record<string, unknown>, allowed: string) {
  const names = new Set(allowed.split(' '))
  if (Object.keys(record).some((key) => !names.has(key))) throw new InvalidOperation('Unexpected fields.')
}

function string(record: Record<string, unknown>, key: string, optional = false) {
  const value = record[key]
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string') throw new InvalidOperation('Expected a text field.')
  return value
}

const cardFields = 'cardId dueAt lastReviewAt stability stabilityFast difficulty state scheduleStatus reps lapses scheduledDays learningStep'

export function validateCardState(value: unknown, cardId: string) {
  const card = object(value)
  fields(card, cardFields)
  if (card.cardId !== cardId) throw new InvalidOperation('Card identity does not match.')
  try {
    restoreCard(card as unknown as ReviewCardState)
  } catch {
    throw new InvalidOperation('Invalid FSRS card state.')
  }
}

export function validateOperation(value: unknown, config?: ReviewSchedulerConfig): OutboxOperation {
  const op = object(value)
  fields(op, 'opId operationId schemaVersion entityId kind baseRevision baseServerRevision sequence createdAt payload')
  // Payload is checked separately. Keep the original bytes' semantic content for idempotence.
  return validatePayload(op, config)
}

function validatePayload(op: Record<string, unknown>, config?: ReviewSchedulerConfig): OutboxOperation {
  if (typeof op.kind !== 'string' || !isUuid(op.opId) || (op.operationId !== undefined && op.operationId !== op.opId)
    || op.schemaVersion !== 1 || !integer(op.sequence, 1) || !time(op.createdAt)
    || !integer(op.baseRevision, 0, Number.MAX_SAFE_INTEGER - 1)
    || (op.baseServerRevision !== undefined && !integer(op.baseServerRevision, 1))) {
    throw new InvalidOperation('Invalid operation identity or version.')
  }
  const payload = object(op.payload)
  if (!isUuid(payload.id)) throw new InvalidOperation('Invalid entity or event ID.')
  if (op.kind === 'practice.create' || op.kind === 'review.create') {
    if (!isUuid(payload.deckId) || !isUuid(payload.entryId) || !isUuid(payload.sessionId) || op.baseRevision !== 0) {
      throw new InvalidOperation('Invalid study event identity.')
    }
    if (op.kind === 'practice.create') {
      fields(payload, 'id deckId entryId sessionId mode outcome attempts firstTryCorrect assisted startedAt completedAt')
      if (op.entityId !== payload.entryId || (payload.mode !== 'copy' && payload.mode !== 'dictation')
        || (payload.outcome !== 'completed' && payload.outcome !== 'skipped') || !integer(payload.attempts)
        || typeof payload.firstTryCorrect !== 'boolean' || typeof payload.assisted !== 'boolean'
        || !time(payload.startedAt) || !time(payload.completedAt)) throw new InvalidOperation('Invalid practice event.')
    } else {
      fields(payload, 'id cardId deckId entryId sessionId direction rating reviewedAt schedulerModel schedulerConfigVersion schedulerConfigSnapshot previousCardState resultingCardState schedulerRevlog')
      const cardId = reviewCardId(payload.entryId)
      if (op.entityId !== cardId || payload.cardId !== cardId || payload.direction !== REVIEW_DIRECTION
        || typeof payload.rating !== 'string' || !isReviewRating(payload.rating) || !time(payload.reviewedAt)) {
        throw new InvalidOperation('Invalid review event.')
      }
      if (!config || payload.schedulerModel !== 'FSRS-7' || payload.schedulerConfigVersion !== config.version
        || stableJson(payload.schedulerConfigSnapshot) !== stableJson(config)) {
        throw new InvalidOperation('This review uses an unsupported scheduler configuration.')
      }
      validateCardState(payload.resultingCardState, cardId)
      if (payload.previousCardState !== undefined) validateCardState(payload.previousCardState, cardId)
      const log = object(payload.schedulerRevlog)
      fields(log, 'cardId dueAt lastReviewAt stability stabilityFast difficulty state scheduleStatus scheduledDays learningStep rating reviewTime')
      if (log.rating !== payload.rating || log.reviewTime !== payload.reviewedAt) throw new InvalidOperation('Invalid review log.')
      const { rating: _rating, reviewTime: _time, ...oldState } = log
      validateCardState({ ...oldState, reps: 0, lapses: 0 }, cardId)
    }
    return op as unknown as OutboxOperation
  }

  if (op.entityId !== payload.id || payload.revision !== op.baseRevision + 1
    || !time(payload.createdAt) || !time(payload.updatedAt) || payload.updatedAt < payload.createdAt) {
    throw new InvalidOperation('Invalid library record revision or time.')
  }
  try {
    switch (op.kind) {
      case 'deck.create': case 'deck.update': case 'deck.archive': case 'deck.restore': {
        fields(payload, 'id name description createdAt updatedAt revision archivedAt')
        const name = string(payload, 'name')!
        const description = string(payload, 'description', true)
        const clean = cleanDeck({ name, description })
        if (name !== clean.name || description !== clean.description || !validTombstone(payload.archivedAt, op.kind, 'archive')) {
          throw new InvalidOperation('Invalid deck fields.')
        }
        break
      }
      case 'entry.create': case 'entry.update': case 'entry.delete': case 'entry.restore': {
        fields(payload, 'id deckId term meaning phonetic example note normalizedTerm createdAt updatedAt revision deletedAt termChangedAt')
        const term = string(payload, 'term')!
        const meaning = string(payload, 'meaning')!
        const phonetic = string(payload, 'phonetic', true)
        const example = string(payload, 'example', true)
        const note = string(payload, 'note', true)
        const clean = cleanEntry({ term, meaning, phonetic, example, note })
        if (term !== clean.term || meaning !== clean.meaning || phonetic !== clean.phonetic
          || example !== clean.example || note !== clean.note || !isUuid(payload.deckId)
          || payload.normalizedTerm !== normalizeTerm(term) || !validTombstone(payload.deletedAt, op.kind, 'delete')
          || (payload.termChangedAt !== undefined && !time(payload.termChangedAt))) {
          throw new InvalidOperation('Invalid entry fields.')
        }
        break
      }
      default: throw new InvalidOperation('Unsupported operation type.')
    }
  } catch (error) {
    if (error instanceof LibraryError) throw new InvalidOperation(error.message)
    throw error
  }
  if (String(op.kind).endsWith('.create') && (op.baseRevision !== 0 || op.baseServerRevision !== undefined)) {
    throw new InvalidOperation('A create must start at revision one.')
  }
  return op as unknown as OutboxOperation
}

function validTombstone(value: unknown, kind: string, suffix: 'archive' | 'delete') {
  return kind.endsWith('.' + suffix) ? time(value) : value === undefined
}
