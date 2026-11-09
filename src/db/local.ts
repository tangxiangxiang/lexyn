import Dexie, { type EntityTable } from 'dexie'

export type Appearance = 'system' | 'light' | 'dark'

interface Preference {
  key: 'appearance'
  value: Appearance
}

interface SyncMeta {
  key: string
  value: string
}

interface OutboxEntry {
  operationId: string
  createdAt: number
  payload: unknown
}

export class LexynLocalDatabase extends Dexie {
  preferences!: EntityTable<Preference, 'key'>
  sync_meta!: EntityTable<SyncMeta, 'key'>
  client_outbox!: EntityTable<OutboxEntry, 'operationId'>

  constructor() {
    super('lexyn')
    this.version(1).stores({
      preferences: 'key',
      sync_meta: 'key',
      client_outbox: 'operationId, createdAt',
    })
  }
}

const db = new LexynLocalDatabase()

export async function readAppearance(): Promise<Appearance> {
  return (await db.preferences.get('appearance'))?.value ?? 'system'
}

export async function writeAppearance(value: Appearance) {
  await db.preferences.put({ key: 'appearance', value })
}
