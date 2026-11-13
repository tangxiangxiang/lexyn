import type { Deck, DeckList, DeckListMember, Entry } from '../domain/library.ts'
import type { ReviewCard, ReviewEvent, ReviewSchedulerConfig } from '../domain/review.ts'
import type { LearnProgress, PracticeEvent } from '../domain/learning.ts'

import type { SpellingAttempt, SpellingPreferences } from '../domain/spelling.ts'

import type { Word, WordCardLink, WordHistoryLink, WordProgress } from '../domain/word.ts'

export const libraryFormatVersion = 8

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
  settings: { dailyNewWords: number; timezone: string; studyWeekdays?: number; reviewResetMinutes?: number; spelling?: SpellingPreferences }
}

export type LibraryExport = LibraryBackupData & (
  | { formatVersion: 4 | 5 }
  | { formatVersion: 6; lists: DeckList[]; listMembers: DeckListMember[] }
  | { formatVersion: 7; lists: DeckList[]; listMembers: DeckListMember[]; spellingAttempts: SpellingAttempt[] }
  | { formatVersion: typeof libraryFormatVersion; lists: DeckList[]; listMembers: DeckListMember[]; spellingAttempts: SpellingAttempt[]
    words: Word[]; wordProgress: WordProgress[]; wordCards: WordCardLink[]; practiceWords: WordHistoryLink[]; spellingWords: WordHistoryLink[] }
)
