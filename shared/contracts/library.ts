import type { Deck, DeckList, DeckListMember, Entry } from '../domain/library.ts'
import type { ReviewCard, ReviewEvent, ReviewSchedulerConfig } from '../domain/review.ts'
import type { LearnProgress, PracticeEvent } from '../domain/learning.ts'

export const libraryFormatVersion = 6

interface LibraryBackupData {
  format: 'lexyn-library'
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

export type LibraryExport = LibraryBackupData & (
  | { formatVersion: 4 | 5 }
  | { formatVersion: typeof libraryFormatVersion; lists: DeckList[]; listMembers: DeckListMember[] }
)
