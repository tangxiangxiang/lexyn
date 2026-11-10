import { DefaultScheduler, Rating, State, type DefaultSchedulerOptions, type DefaultSchedulerCard,
  type DefaultSchedulerRevlog } from 'ts-fsrs'
import { FSRS7Model } from 'ts-fsrs/models/fsrs-7'
import type { ReviewCardState, ReviewEvent, ReviewRating, ReviewRevlog, ReviewSchedulerConfig } from '../domain/review.ts'

export const FSRS_MODEL = 'FSRS-7'
export const DEFAULT_DESIRED_RETENTION = 0.9
export const REVIEW_CONFIG_VERSION = 'fsrs-7-v1'
const PACKAGE_VERSION = '6.0.0'

const defaultOptions = {
  version: FSRS_MODEL,
  desiredRetention: DEFAULT_DESIRED_RETENTION,
  enableFuzz: false,
} satisfies DefaultSchedulerOptions<'FSRS-7'>

export async function createReviewScheduler(options: DefaultSchedulerOptions<'FSRS-7'> = defaultOptions) {
  const scheduler = await DefaultScheduler(options)
  if (scheduler.definition.model.name !== FSRS7Model.name) throw new Error('Expected the FSRS-7 model.')
  return scheduler
}

export type ReviewScheduler = Awaited<ReturnType<typeof createReviewScheduler>>

export const schedulerGrades = {
  again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy,
} as const satisfies Record<ReviewRating, number>

export function isReviewRating(rating: string): rating is ReviewRating {
  return Object.hasOwn(schedulerGrades, rating)
}

export function schedulerConfigSnapshot(scheduler: ReviewScheduler): ReviewSchedulerConfig {
  const { weights, desiredRetention, enableFuzz, enableShortTerm, learningSteps, relearningSteps,
    maximumInterval, graduatingInterval, clearStatsOnForget, allowModelOverride } = scheduler.config
  return {
    version: REVIEW_CONFIG_VERSION, packageVersion: PACKAGE_VERSION,
    options: {
      version: FSRS_MODEL, weights: [...weights], desiredRetention: desiredRetention[Rating.Good],
      enableFuzz, enableShortTerm, learningSteps: [...learningSteps], relearningSteps: [...relearningSteps],
      maximumInterval, graduatingInterval, clearStatsOnForget, allowModelOverride,
    },
  }
}

export function serializeCard({ dueAt, lastReviewAt, ...fields }: DefaultSchedulerCard<'FSRS-7'>): ReviewCardState {
  return { ...fields, dueAt: dueAt.getTime(), lastReviewAt: lastReviewAt?.getTime() ?? null }
}

function utcDate(timestamp: number) {
  if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > 8.64e15) {
    throw new RangeError('Invalid review timestamp.')
  }
  return new Date(timestamp)
}

export function restoreCard(state: ReviewCardState): DefaultSchedulerCard<'FSRS-7'> {
  const { dueAt, lastReviewAt, stability, stabilityFast, difficulty, reps, lapses, scheduledDays, learningStep } = state
  if (typeof state.cardId !== 'string' || !state.cardId || !Object.values(State).includes(state.state)
    || !['new', 'learning', 'review'].includes(state.scheduleStatus)
    || ![stability, stabilityFast, difficulty, scheduledDays].every((value) => Number.isFinite(value) && value >= 0)
    || ![reps, lapses, learningStep].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid FSRS card state.')
  }
  return { ...state, dueAt: utcDate(dueAt), lastReviewAt: lastReviewAt === null ? null : utcDate(lastReviewAt) }
}

export function serializeRevlog(
  { dueAt, lastReviewAt, reviewTime, rating: _, ...fields }: DefaultSchedulerRevlog<'FSRS-7'>,
  rating: ReviewRating,
): ReviewRevlog {
  return { ...fields, rating, dueAt: dueAt.getTime(), lastReviewAt: lastReviewAt?.getTime() ?? null,
    reviewTime: reviewTime.getTime() }
}

/** Replay one card's immutable events in UTC order with a stable tie-breaker. */
export async function rebuildCardFromEvents(
  events: readonly ReviewEvent[], onReview?: (event: ReviewEvent, state: ReviewCardState) => void,
): Promise<ReviewCardState | undefined> {
  const time = (event: ReviewEvent) => event.reviewedAt
  const ordered = [...events].sort((a, b) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const schedulers = new Map<string, ReviewScheduler>()
  let card: DefaultSchedulerCard<'FSRS-7'> | undefined
  for (const event of ordered) {
    const config = event.schedulerConfigSnapshot
    if (event.cardId !== ordered[0].cardId || !isReviewRating(event.rating)) {
      throw new Error('Review history contains an invalid card or rating.')
    }
    if (event.schedulerModel !== FSRS_MODEL || config.options.version !== FSRS_MODEL
      || config.packageVersion !== PACKAGE_VERSION || config.version !== event.schedulerConfigVersion) {
      throw new Error('This review history requires a different scheduler version.')
    }
    const key = JSON.stringify(config.options)
    let scheduler = schedulers.get(key)
    if (!scheduler) {
      scheduler = await createReviewScheduler(config.options)
      schedulers.set(key, scheduler)
    }
    const now = utcDate(time(event))
    card ??= scheduler.newCard({ now, cardId: event.cardId })
    card = scheduler.review({ card, grade: schedulerGrades[event.rating], now }).card
    onReview?.(event, serializeCard(card))
  }
  return card && serializeCard(card)
}
