import Dexie, { type EntityTable } from 'dexie'
import type { LibraryOperation } from '../../shared/contracts/library'
import type { Deck, Entry } from '../../shared/domain/library'

export type Appearance = 'system' | 'light' | 'dark'

interface Preference {
  key: 'appearance'
  value: Appearance
}

interface SyncMeta {
  key: string
  value: string
}

interface LegacyOutboxEntry {
  operationId: string
  createdAt: number
  payload: unknown
}

export type OutboxEntry = LegacyOutboxEntry | (LibraryOperation & { operationId: string })

export interface DeckRecord extends Deck {
  serverRevision?: number
}

export interface EntryRecord extends Entry {
  serverRevision?: number
  activeTerm?: string
}

export class LexynLocalDatabase extends Dexie {
  preferences!: EntityTable<Preference, 'key'>
  sync_meta!: EntityTable<SyncMeta, 'key'>
  client_outbox!: EntityTable<OutboxEntry, 'operationId'>
  decks!: EntityTable<DeckRecord, 'id'>
  entries!: EntityTable<EntryRecord, 'id'>

  constructor(name = 'lexyn') {
    super(name)
    this.version(1).stores({
      preferences: 'key',
      sync_meta: 'key',
      client_outbox: 'operationId, createdAt',
    })
    this.version(2).stores({
      decks: 'id',
      entries: 'id, deckId, &[deckId+activeTerm]',
      client_outbox: 'operationId, createdAt, &sequence',
    })
  }
}

export const db = new LexynLocalDatabase()

export async function readAppearance(): Promise<Appearance> {
  return (await db.preferences.get('appearance'))?.value ?? 'system'
}

export async function writeAppearance(value: Appearance) {
  await db.preferences.put({ key: 'appearance', value })
}
