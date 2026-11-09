import type { Deck, Entry } from '../domain/library'
import type { PracticeEvent } from '../domain/learning'

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

export type OutboxOperation = LibraryOperation | PracticeOperation
export type PracticeChange = Omit<PracticeOperation, 'sequence' | 'createdAt' | 'operationId'> & { operationId?: string }
export type OutboxChange = (LibraryChange | PracticeChange) & { baseServerRevision?: number }

export interface LibraryExport {
  format: 'lexyn-library'
  formatVersion: 2
  exportedAt: string
  metadata: { librarySchemaVersion: 3; scope: 'library' | 'deck' }
  decks: Deck[]
  entries: Entry[]
  practiceEvents: PracticeEvent[]
  learnProgress: import('../domain/learning').LearnProgress[]
  dailyNewWords: number
}
