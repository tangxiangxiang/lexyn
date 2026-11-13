import type { DefaultSchedulerCard, DefaultSchedulerOptions, DefaultSchedulerRevlog } from 'ts-fsrs'

export const REVIEW_DIRECTION = 'meaning-to-term'
export type ReviewDirection = typeof REVIEW_DIRECTION
export const reviewRatings = ['again', 'hard', 'good', 'easy'] as const
export type ReviewRating = typeof reviewRatings[number]

export function reviewCardId(entryId: string) {
  return `${REVIEW_DIRECTION}:${entryId}`
}

export function wordReviewCardId(wordId: string) {
  return `${REVIEW_DIRECTION}:word:${wordId}`
}

type SchedulerCard = DefaultSchedulerCard<'FSRS-7'>
type SchedulerRevlog = DefaultSchedulerRevlog<'FSRS-7'>

export interface ReviewCardState extends Omit<SchedulerCard, 'dueAt' | 'lastReviewAt'> {
  dueAt: number
  lastReviewAt: number | null
}

export interface ReviewRevlog extends Omit<SchedulerRevlog, 'dueAt' | 'lastReviewAt' | 'reviewTime' | 'rating'> {
  dueAt: number
  lastReviewAt: number | null
  reviewTime: number
  rating: ReviewRating
}

export interface ReviewSchedulerConfig {
  version: string
  packageVersion: string
  options: Required<DefaultSchedulerOptions<'FSRS-7'>>
}

export interface ReviewCard {
  id: string
  entryId: string
  deckId: string
  direction: ReviewDirection
  revision: number
  lastEventId: string
  createdAt: number
  updatedAt: number
  schedulerConfigVersion: string
  schedulerState: ReviewCardState
  dueAt: number
  scheduleStatus: ReviewCardState['scheduleStatus']
}

export interface ReviewEvent {
  readonly id: string
  readonly cardId: string
  readonly entryId: string
  readonly deckId: string
  readonly sessionId: string
  readonly direction: ReviewDirection
  readonly rating: ReviewRating
  readonly reviewedAt: number
  readonly schedulerModel: 'FSRS-7'
  readonly schedulerConfigVersion: string
  readonly schedulerConfigSnapshot: ReviewSchedulerConfig
  readonly previousCardState?: ReviewCardState
  readonly resultingCardState: ReviewCardState
  readonly schedulerRevlog: ReviewRevlog
}

export interface ReviewSession {
  studyFlowId?: string
  studyFlowFinished?: boolean
  sessionId: string
  deckId?: string
  entryIds: string[]
  wordIds?: (string | null)[]
  listId?: string
  currentIndex: number
  currentCardId?: string
  currentRevealed: boolean
  revealedEntryRevision?: number
  revealedEntryId?: string
  startedAt: number
  updatedAt: number
  status: 'active' | 'paused' | 'abandoned' | 'completed'
}

/** The forward prompt must contain a Chinese gloss and must not include the target spelling. */
export function recallPrompt(meaning: string, term: string) {
  const spelling = term.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prompt = meaning.normalize('NFC').replace(new RegExp(spelling, 'giu'), '…').trim()
  return /\p{Script=Han}/u.test(prompt) ? prompt : undefined
}
