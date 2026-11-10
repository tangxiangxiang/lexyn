import { stableJson } from './json.ts'
import { cleanDeck, cleanEntry, normalizeTerm } from '../domain/library.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewCardState, type ReviewSchedulerConfig } from '../domain/review.ts'
import { isReviewRating, restoreCard } from '../srs/scheduler.ts'

export class InvalidInput extends Error {}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInput('Expected an object.')
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
  if (Object.keys(record).some((key) => !names.has(key))) throw new InvalidInput('Unexpected fields.')
}

function string(record: Record<string, unknown>, key: string, optional = false) {
  const value = record[key]
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string') throw new InvalidInput('Expected a text field.')
  return value
}

const cardFields = 'cardId dueAt lastReviewAt stability stabilityFast difficulty state scheduleStatus reps lapses scheduledDays learningStep'

export function validateCardState(value: unknown, cardId: string) {
  const card = object(value)
  fields(card, cardFields)
  if (card.cardId !== cardId) throw new InvalidInput('Card identity does not match.')
  try {
    restoreCard(card as unknown as ReviewCardState)
  } catch {
    throw new InvalidInput('Invalid FSRS card state.')
  }
}

export function validateEntity(payload: Record<string, unknown>, kind: 'deck' | 'entry') {
  if (!isUuid(payload.id) || !integer(payload.revision, 1) || !time(payload.createdAt)
    || !time(payload.updatedAt) || Number(payload.updatedAt) < Number(payload.createdAt)) {
    throw new InvalidInput('Invalid library record revision or time.')
  }
  if (kind === 'deck') {
    fields(payload, 'id name description createdAt updatedAt revision archivedAt')
    const name = string(payload, 'name')!
    const description = string(payload, 'description', true)
    const clean = cleanDeck({ name, description })
    if (name !== clean.name || description !== clean.description || (payload.archivedAt !== undefined && !time(payload.archivedAt))) {
      throw new InvalidInput('Invalid deck fields.')
    }
    return payload.id
  }
  fields(payload, 'id deckId term meaning phonetic example note normalizedTerm createdAt updatedAt revision deletedAt termChangedAt')
  const term = string(payload, 'term')!
  const meaning = string(payload, 'meaning')!
  const phonetic = string(payload, 'phonetic', true)
  const example = string(payload, 'example', true)
  const note = string(payload, 'note', true)
  const clean = cleanEntry({ term, meaning, phonetic, example, note })
  if (term !== clean.term || meaning !== clean.meaning || phonetic !== clean.phonetic
    || example !== clean.example || note !== clean.note || !isUuid(payload.deckId)
    || payload.normalizedTerm !== normalizeTerm(term) || (payload.deletedAt !== undefined && !time(payload.deletedAt))
    || (payload.termChangedAt !== undefined && !time(payload.termChangedAt))) {
    throw new InvalidInput('Invalid entry fields.')
  }
  return payload.id
}

export function validateEvent(payload: Record<string, unknown>, kind: 'practice' | 'review', config: ReviewSchedulerConfig) {
  if (!isUuid(payload.id) || !isUuid(payload.deckId) || !isUuid(payload.entryId) || !isUuid(payload.sessionId)) {
    throw new InvalidInput('Invalid study event identity.')
  }
  if (kind === 'practice') {
    fields(payload, 'id deckId entryId sessionId mode outcome attempts firstTryCorrect assisted startedAt completedAt')
    if ((payload.mode !== 'copy' && payload.mode !== 'dictation') || (payload.outcome !== 'completed' && payload.outcome !== 'skipped')
      || !integer(payload.attempts) || typeof payload.firstTryCorrect !== 'boolean' || typeof payload.assisted !== 'boolean'
      || !time(payload.startedAt) || !time(payload.completedAt)) throw new InvalidInput('Invalid practice event.')
    return payload.id
  }
  fields(payload, 'id cardId deckId entryId sessionId direction rating reviewedAt schedulerModel schedulerConfigVersion schedulerConfigSnapshot previousCardState resultingCardState schedulerRevlog')
  const cardId = reviewCardId(payload.entryId)
  if (payload.cardId !== cardId || payload.direction !== REVIEW_DIRECTION
    || typeof payload.rating !== 'string' || !isReviewRating(payload.rating) || !time(payload.reviewedAt)) {
    throw new InvalidInput('Invalid review event.')
  }
  if (payload.schedulerModel !== 'FSRS-7' || payload.schedulerConfigVersion !== config.version
    || stableJson(payload.schedulerConfigSnapshot) !== stableJson(config)) {
    throw new InvalidInput('This review uses an unsupported scheduler configuration.')
  }
  validateCardState(payload.resultingCardState, cardId)
  if (payload.previousCardState !== undefined) validateCardState(payload.previousCardState, cardId)
  const log = object(payload.schedulerRevlog)
  fields(log, 'cardId dueAt lastReviewAt stability stabilityFast difficulty state scheduleStatus scheduledDays learningStep rating reviewTime')
  if (log.rating !== payload.rating || log.reviewTime !== payload.reviewedAt) throw new InvalidInput('Invalid review log.')
  const { rating: _rating, reviewTime: _time, ...oldState } = log
  validateCardState({ ...oldState, reps: 0, lapses: 0 }, cardId)
  return payload.id
}

export function validateTimezone(value: unknown) {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-z0-9_+\-/]+$/i.test(value) || /^[+-]/.test(value)) {
    throw new InvalidInput('Enter an IANA timezone such as Asia/Shanghai.')
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value }) }
  catch { throw new InvalidInput('Enter a valid IANA timezone.') }
  return value
}
