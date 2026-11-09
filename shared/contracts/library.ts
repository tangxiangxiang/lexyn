import type { Deck, Entry } from '../domain/library.ts'
import type { ReviewCard, ReviewEvent, ReviewSchedulerConfig } from '../domain/review.ts'
import type { PracticeEvent } from '../domain/learning.ts'

export type DeckOperationKind = 'deck.create' | 'deck.update' | 'deck.archive' | 'deck.restore'
export type EntryOperationKind = 'entry.create' | 'entry.update' | 'entry.delete' | 'entry.restore'

export type LibraryChange =
  | { kind: DeckOperationKind; payload: Deck }
  | { kind: EntryOperationKind; payload: Entry }

export type LibraryOperation = LibraryChange & {
  opId: string
  schemaVersion: 1
  entityId: string
  baseRevision: number
  baseServerRevision?: number
  sequence: number
  createdAt: number
}

export type PracticeOperation = {
  opId: string
  schemaVersion: 1
  entityId: string
  kind: 'practice.create'
  payload: PracticeEvent
  baseRevision: number
  baseServerRevision?: number
  sequence: number
  createdAt: number
}

export type ReviewOperation = Omit<PracticeOperation, 'kind' | 'payload'> & {
  kind: 'review.create'
  payload: ReviewEvent
}

export type OutboxOperation = LibraryOperation | PracticeOperation | ReviewOperation
export type PracticeChange = Omit<PracticeOperation, 'sequence' | 'createdAt' | 'operationId'> & { operationId?: string }
export type ReviewChange = Omit<ReviewOperation, 'sequence' | 'createdAt'>
export type OutboxChange = (LibraryChange | PracticeChange | ReviewChange) & { baseServerRevision?: number }

export interface LibraryExportV2 {
  format: 'lexyn-library'
  formatVersion: 2
  exportedAt: string
  metadata: { librarySchemaVersion: 3; scope: 'library' | 'deck' }
  decks: Deck[]
  entries: Entry[]
  practiceEvents: PracticeEvent[]
  learnProgress: import('../domain/learning.ts').LearnProgress[]
  dailyNewWords: number
}

export interface LibraryExport extends Omit<LibraryExportV2, 'formatVersion' | 'metadata'> {
  formatVersion: 3
  metadata: { librarySchemaVersion: 4; scope: 'library' | 'deck' }
  reviewCards: ReviewCard[]
  reviewEvents: ReviewEvent[]
  schedulerConfig: ReviewSchedulerConfig
}
