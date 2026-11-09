import type { Deck, Entry } from '../domain/library'

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

export interface LibraryExport {
  format: 'lexyn-library'
  formatVersion: 1
  exportedAt: string
  metadata: { librarySchemaVersion: 2; scope: 'library' | 'deck' }
  decks: Deck[]
  entries: Entry[]
}
