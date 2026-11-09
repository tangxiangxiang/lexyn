import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LexynLocalDatabase } from '../../db/local'
import { parseImport, previewImport, suggestMapping } from './import'
import { createLibraryRepository } from './repository'

let database: LexynLocalDatabase
let library: ReturnType<typeof createLibraryRepository>

beforeEach(() => {
  database = new LexynLocalDatabase(`lexyn-test-${crypto.randomUUID()}`)
  library = createLibraryRepository(database)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await database.delete()
})

test('upgrades v1 without clearing preferences, sync metadata or legacy outbox entries', async () => {
  const legacy = new Dexie(database.name)
  legacy.version(1).stores({ preferences: 'key', sync_meta: 'key', client_outbox: 'operationId, createdAt' })
  await legacy.table('preferences').add({ key: 'appearance', value: 'dark' })
  await legacy.table('sync_meta').add({ key: 'previous', value: 'saved' })
  const previous = { operationId: 'legacy-operation', createdAt: 42, payload: { old: true } }
  await legacy.table('client_outbox').add(previous)
  legacy.close()
  await database.open()
  expect(database.verno).toBe(2)
  expect(await database.preferences.get('appearance')).toEqual({ key: 'appearance', value: 'dark' })
  expect(await database.sync_meta.get('previous')).toEqual({ key: 'previous', value: 'saved' })
  expect(await database.client_outbox.get(previous.operationId)).toEqual(previous)
  expect(await library.listDecks()).toEqual([])
})

test('edits, archives and restores a deck without replacing its ID or entries', async () => {
  const deck = await library.createDeck({ name: ' Computer English ' })
  await library.updateDeck(deck.id, { name: 'Systems English', description: ' Notes ' }, 1)
  await expect(library.updateDeck(deck.id, { name: 'Stale name' }, 1)).rejects.toThrow('changed')
  const word = await library.createEntry(deck.id, { term: 'copy-on-write', meaning: '' })
  await library.setDeckArchived(deck.id, true)
  await expect(library.createEntry(deck.id, { term: 'deadlock', meaning: '死锁' })).rejects.toThrow('Restore')
  expect((await library.getDeck(deck.id))?.deck.archivedAt).toEqual(expect.any(Number))
  await library.setDeckArchived(deck.id, false)
  expect((await library.getDeck(deck.id))?.deck).toMatchObject({ id: deck.id, name: 'Systems English', description: 'Notes', revision: 4 })
  expect((await library.getDeck(deck.id))?.entries).toEqual([word])
  expect(await database.client_outbox.orderBy('sequence').toArray()).toMatchObject([
    { kind: 'deck.create', sequence: 1, baseRevision: 0, entityId: deck.id },
    { kind: 'deck.update', sequence: 2, baseRevision: 1, entityId: deck.id },
    { kind: 'entry.create', sequence: 3, baseRevision: 0, entityId: word.id },
    { kind: 'deck.archive', sequence: 4, baseRevision: 2, entityId: deck.id },
    { kind: 'deck.restore', sequence: 5, baseRevision: 3, entityId: deck.id },
  ])
})

test('enforces active per-deck uniqueness and detects conflicts on restore', async () => {
  const first = await library.createDeck({ name: 'First' })
  const second = await library.createDeck({ name: 'Second' })
  const entry = await library.createEntry(first.id, { term: ' Café ', meaning: '' })
  await expect(library.createEntry(first.id, { term: 'CAFE\u0301', meaning: '' })).rejects.toThrow('already has')
  await library.createEntry(second.id, { term: 'CAFE\u0301', meaning: '' })
  await library.updateEntry(first.id, entry.id, { term: 'Café', meaning: '咖啡' }, 1)
  await library.setEntryRemoved(first.id, entry.id, true)
  const replacement = await library.createEntry(first.id, { term: 'CAFÉ', meaning: '另一条' })
  await expect(library.setEntryRemoved(first.id, entry.id, false)).rejects.toThrow('already has')
  await library.setEntryRemoved(first.id, replacement.id, true)
  await library.setEntryRemoved(first.id, entry.id, false)
  expect((await library.getDeck(first.id))?.entries.find(({ id }) => id === entry.id)).toMatchObject({
    id: entry.id, revision: 4, meaning: '咖啡', deletedAt: undefined,
  })
})

test('serializes concurrent writes for the same normalized term', async () => {
  const { id } = await library.createDeck({ name: 'Systems' })
  const results = await Promise.allSettled([
    library.createEntry(id, { term: 'Lock-free', meaning: '' }),
    library.createEntry(id, { term: 'LOCK-FREE', meaning: '' }),
  ])
  expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected'])
  expect(await database.entries.count()).toBe(1)
  expect(await database.client_outbox.count()).toBe(2)
})

test('imports first valid occurrences, skips matches by default and only overwrites mapped fields', async () => {
  const { id } = await library.createDeck({ name: 'Systems' })
  const word = await library.createEntry(id, { term: 'WAL', meaning: '旧释义', note: '保留' })
  const source = parseImport('term,meaning\nwal,预写日志\nWAL,重复\nlock-free,\n,无效', 'csv')
  const preview = async () => previewImport(source, suggestMapping(source.headers), (await library.getDeck(id))!.entries)
  expect(await preview()).toMatchObject({ valid: 3, duplicates: 2, invalid: 1, missingMeaning: 1 })
  expect(await library.importEntries(id, await preview(), 'skip')).toEqual({ added: 1, updated: 0, skipped: 2, invalid: 1 })
  expect(await library.importEntries(id, await preview(), 'overwrite')).toEqual({ added: 0, updated: 2, skipped: 1, invalid: 1 })
  expect((await library.getDeck(id))?.entries.find((entry) => entry.id === word.id)).toMatchObject({
    id: word.id, revision: 2, meaning: '预写日志', note: '保留',
  })
})

test('rejects stale or invalid imports and rolls back entries when outbox writes fail', async () => {
  const { id } = await library.createDeck({ name: 'Systems' })
  const source = parseImport('term,meaning\ndeadlock,死锁\nWAL,预写日志', 'csv')
  const preview = previewImport(source, suggestMapping(source.headers), [])
  await library.createEntry(id, { term: 'wal', meaning: '旧释义' })
  await expect(library.importEntries(id, preview, 'overwrite')).rejects.toThrow('changed')
  expect(await database.entries.count()).toBe(1)
  const latest = previewImport(source, suggestMapping(source.headers), (await library.getDeck(id))!.entries)
  vi.spyOn(database.client_outbox, 'bulkAdd').mockRejectedValueOnce(new Error('outbox write failed'))
  await expect(library.importEntries(id, latest, 'overwrite')).rejects.toThrow('outbox write failed')
  expect((await library.getDeck(id))?.entries).toMatchObject([{ term: 'wal', meaning: '旧释义', revision: 1 }])
  expect(await database.client_outbox.count()).toBe(2)
  expect(await database.sync_meta.get('library.outbox.sequence')).toMatchObject({ value: '2' })
  expect(() => parseImport('term,meaning\ndeadlock,死锁\n"broken', 'csv')).toThrow('Invalid CSV')
  expect(await database.entries.count()).toBe(1)
})

test('exports archived decks and removed words without internal storage fields', async () => {
  const { id } = await library.createDeck({ name: 'Systems' })
  const word = await library.createEntry(id, { term: 'deadlock', meaning: '死锁' })
  await library.setEntryRemoved(id, word.id, true)
  await library.setDeckArchived(id, true)
  const result = JSON.parse(JSON.stringify(await library.exportLibrary()))
  expect(result).toEqual({
    format: 'lexyn-library', formatVersion: 1, exportedAt: expect.any(String),
    metadata: { librarySchemaVersion: 2, scope: 'library' },
    decks: [{
      id, name: 'Systems', revision: 2, archivedAt: expect.any(Number),
      createdAt: expect.any(Number), updatedAt: expect.any(Number),
    }],
    entries: [{
      id: word.id, deckId: id, term: 'deadlock', normalizedTerm: 'deadlock', meaning: '死锁',
      revision: 2, deletedAt: expect.any(Number), createdAt: expect.any(Number), updatedAt: expect.any(Number),
    }],
  })
  const log = await database.client_outbox.orderBy('sequence').toArray()
  expect(log.every((operation) => 'opId' in operation && operation.opId === operation.operationId)).toBe(true)
  expect(new Set(log.map(({ operationId }) => operationId)).size).toBe(log.length)
})
