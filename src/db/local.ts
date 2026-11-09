import Dexie, { type EntityTable } from 'dexie'
import type { OutboxOperation } from '../../shared/contracts/library'
import type { Deck, Entry } from '../../shared/domain/library'
import type { LearnProgress, LearnSession, PracticeEvent, DailyNewWords } from '../../shared/domain/learning'

export type Appearance = 'system' | 'light' | 'dark'

interface Preference {
  key: 'appearance' | 'daily-new-words'
  value: Appearance | number
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

export type OutboxEntry = LegacyOutboxEntry | (OutboxOperation & { operationId: string })

export interface DeckRecord extends Deck {
  serverRevision?: number
}

export interface EntryRecord extends Entry {
  serverRevision?: number
  activeTerm?: string
}

export type PracticeRecord = PracticeEvent
export type LearnProgressRecord = LearnProgress
export type LearnSessionRecord = LearnSession

export class LexynLocalDatabase extends Dexie {
  preferences!: EntityTable<Preference, 'key'>
  sync_meta!: EntityTable<SyncMeta, 'key'>
  client_outbox!: EntityTable<OutboxEntry, 'operationId'>
  decks!: EntityTable<DeckRecord, 'id'>
  entries!: EntityTable<EntryRecord, 'id'>
  practice_events!: EntityTable<PracticeRecord, 'id'>
  learn_progress!: EntityTable<LearnProgressRecord, 'entryId'>
  learn_sessions!: EntityTable<LearnSessionRecord, 'sessionId'>

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
    this.version(3).stores({
      decks: 'id',
      entries: 'id, deckId, &[deckId+activeTerm]',
      client_outbox: 'operationId, createdAt, &sequence',
      preferences: 'key',
      sync_meta: 'key',
      practice_events: 'id, deckId, entryId, sessionId, startedAt, completedAt, [entryId+completedAt], [deckId+completedAt]',
      learn_progress: 'entryId, firstCompletedAt, lastPracticedAt',
      learn_sessions: 'sessionId, deckId, status, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('preferences').put({ key: 'daily-new-words', value: 10 })
    })
  }
}

export const db = new LexynLocalDatabase()

export async function readAppearance(): Promise<Appearance> {
  const value = (await db.preferences.get('appearance'))?.value
  return value === 'dark' || value === 'light' ? value : 'system'
}

export async function writeAppearance(value: Appearance) {
  await db.preferences.put({ key: 'appearance', value })
}

export async function readDailyNewWords(): Promise<number> {
  const preference = await db.preferences.get('daily-new-words')
  const count = preference?.value
  return typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 100 ? count : 10
}

export async function writeDailyNewWords(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError('Daily new words must be between 1 and 100.')
  await db.preferences.put({ key: 'daily-new-words', value })
}
