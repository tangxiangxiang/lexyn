import type { Deck, Entry } from '../domain/library.ts'
import type { ReviewCard, ReviewEvent, ReviewSchedulerConfig } from '../domain/review.ts'
import type { LearnProgress, PracticeEvent } from '../domain/learning.ts'

export interface LibraryExport {
  format: 'lexyn-library'
  formatVersion: 4
  exportedAt: string
  metadata: { scope: 'library' | 'deck' }
  decks: Deck[]
  entries: Entry[]
  practiceEvents: PracticeEvent[]
  learnProgress: LearnProgress[]
  reviewCards: ReviewCard[]
  reviewEvents: ReviewEvent[]
  schedulerConfig: ReviewSchedulerConfig
  settings: { dailyNewWords: number; timezone: string }
}
