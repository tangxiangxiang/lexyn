import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SyncPage, SyncRecord } from '../../../shared/contracts/sync'
import { reviewCardId } from '../../../shared/domain/review'
import { LexynLocalDatabase } from '../../db/local'
import { createLibraryRepository } from '../library/repository'
import { createLearnRepository } from '../learn/repository'
import { createReviewRepository } from '../review/repository'
import { createSyncStore } from './repository'

let database: LexynLocalDatabase
let sync: ReturnType<typeof createSyncStore>
let library: ReturnType<typeof createLibraryRepository>
const owner = 'owner'
const origin = 'https://lexyn.example'
const lease = 'test-tab'
const now = Date.UTC(2026, 0, 1)

beforeEach(async () => {
  database = new LexynLocalDatabase('lexyn-test-' + crypto.randomUUID())
  sync = createSyncStore(database)
  library = createLibraryRepository(database)
  await sync.initialize()
  await sync.acquire(owner, origin, lease)
})

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await database.delete() })

function page(records: SyncRecord[], after = 0, head = after + records.length): SyncPage {
  const nextCursor = after + records.length
  return { schemaVersion: 1, ownerId: owner, serverSeq: head, nextCursor, hasMore: nextCursor < head,
    changes: records.map((record, index) => ({ seq: after + index + 1, record })) }
}

test('preserves a v4 database, Outbox identities and theme and initializes one stable device', async () => {
  const deck = await library.createDeck({ name: 'Existing' })
  const records = await database.client_outbox.toArray()
  const name = database.name + '-old'
  const old = new Dexie(name)
  old.version(4).stores({
    decks: 'id', preferences: 'key', client_outbox: 'operationId, createdAt, &sequence',
    review_events: 'id, cardId, entryId, sessionId, reviewedAt, [cardId+reviewedAt], &[sessionId+cardId]',
  })
  const upgraded = new LexynLocalDatabase(name)
  try {
    await old.table('decks').add(deck)
    await old.table('preferences').add({ key: 'appearance', value: 'dark' })
    await old.table('client_outbox').bulkAdd(records)
    old.close()
    expect(await upgraded.decks.toArray()).toEqual([deck])
    expect(await upgraded.client_outbox.toArray()).toEqual(records)
    expect(await upgraded.preferences.get('appearance')).toEqual({ key: 'appearance', value: 'dark' })
    expect(upgraded.verno).toBe(5)
    const device = await createSyncStore(upgraded).initialize()
    upgraded.close()
    await upgraded.open()
    expect((await createSyncStore(upgraded).initialize()).deviceId).toBe(device.deviceId)
  } finally { old.close(); await upgraded.delete() }
})

test('atomically applies a page and cursor and resumes a fixed bootstrap watermark', async () => {
  const deck = { id: 'deck', name: 'Remote', revision: 1, createdAt: now, updatedAt: now }
  const word = { id: 'word', deckId: deck.id, term: 'cache', normalizedTerm: 'cache', meaning: '缓存', revision: 1,
    createdAt: now, updatedAt: now }
  const first = page([{ kind: 'deck', value: deck, serverRevision: 1 }, { kind: 'entry', value: word, serverRevision: 1 }], 0, 3)
  vi.spyOn(database.entries, 'put').mockRejectedValueOnce(new Error('simulated storage failure'))
  await expect(sync.apply(lease, first, true)).rejects.toThrow('simulated')
  expect(await database.decks.count()).toBe(0)
  expect(await database.sync_shadows.count()).toBe(0)
  expect((await sync.status()).state?.cursor).toBe(0)
  await sync.apply(lease, first, true)
  expect((await sync.status()).state).toMatchObject({ cursor: 2, through: 3, bootstrapped: false })
  await expect(sync.apply(lease, page([], 2, 4), true)).rejects.toThrow('cursor')
  await sync.apply(lease, page([{ kind: 'entry', value: { ...word, meaning: '已更新', revision: 2 }, serverRevision: 2 }], 2), true)
  expect((await sync.status()).state).toMatchObject({ cursor: 3, bootstrapped: true })
  expect(await database.entries.get(word.id)).toMatchObject({ meaning: '已更新', serverRevision: 2 })
})

test('ACK rolls back as a unit and clears only applied operations', async () => {
  await library.createDeck({ name: 'A' })
  await library.createDeck({ name: 'B' })
  const batch = await sync.batch(lease)
  const [a, b] = batch
  await expect(sync.acknowledge(lease, batch, { schemaVersion: 1, results: [
    { opId: a.opId, status: 'accepted', serverSeq: 1 },
    { opId: 'unexpected', status: 'accepted', serverSeq: 2 },
  ] })).rejects.toThrow('different operation')
  expect(await database.client_outbox.count()).toBe(2)
  await sync.acknowledge(lease, batch, { schemaVersion: 1, results: [
    { opId: a.opId, status: 'already_applied', serverSeq: 1 },
    { opId: b.opId, status: 'rejected', reason: 'Rejected by fixture' },
  ] })
  expect(await database.client_outbox.toArray()).toMatchObject([{ operationId: b.opId }])
  expect((await sync.status()).issues).toMatchObject([{ opId: b.opId, status: 'rejected' }])
})

test('blocks another account and fences off a stale tab', async () => {
  const other = createSyncStore(database)
  await expect(other.acquire('another-owner', origin, 'other')).rejects.toThrow('different Owner')
  await expect(other.acquire(owner, 'https://other.example', 'other')).rejects.toThrow('different Owner')
  expect(await other.acquire(owner, origin, 'other')).toBeUndefined()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 46_000)
  expect(await other.acquire(owner, origin, 'other')).toMatchObject({ leaseId: 'other' })
  await expect(sync.apply(lease, page([]), true)).rejects.toThrow('Another tab')
})

test('preserves an unsent local rating while pulling another projection and converges after ACK', async () => {
  const deck = await library.createDeck({ name: 'Systems' })
  const word = await library.createEntry(deck.id, { term: 'cache', meaning: '缓存' })
  const learn = createLearnRepository(database)
  const ls = await learn.startSession(deck.id, 'copy', [word.id], true, now)
  await learn.recordAttempt(ls.sessionId, word.term, true, now, word.id)
  await learn.finishCurrent(ls.sessionId, 'completed', now, 0, word.id)
  const review = createReviewRepository(database)
  await review.start(deck.id, now)
  const round = (await review.round(deck.id, now))!
  const cardId = reviewCardId(word.id)
  await review.reveal(round.session.sessionId, cardId, word.revision, now)
  const local = await review.score(round.session.sessionId, cardId, 'good', now)
  const localCard = (await database.review_cards.get(cardId))!
  const remote = { ...local, id: crypto.randomUUID(), rating: 'again' as const, effectiveReviewedAt: now + 1 }
  const projection = { ...localCard, lastEventId: remote.id, revision: 2 }
  const record = { kind: 'review' as const, event: remote, card: projection }
  await sync.apply(lease, page([record]), true)
  expect(await database.review_events.count()).toBe(2)
  expect(await database.review_cards.get(cardId)).toEqual(localCard)
  const sent = (await sync.batch(lease)).filter((op) => op.kind === 'review.create')
  expect(sent).toHaveLength(1)
  await sync.acknowledge(lease, sent, { schemaVersion: 1, results: [{ opId: sent[0].opId, status: 'accepted', serverSeq: 2 }] })
  await sync.apply(lease, page([{ ...record, event: { ...local, effectiveReviewedAt: now } }], 1), false)
  expect(await database.review_events.count()).toBe(2)
  expect(await database.review_cards.get(cardId)).toEqual(projection)
})

test('does not overwrite an unsent edit and resubmits explicitly against the server revision', async () => {
  const deck = { id: 'deck', name: 'Original', revision: 1, createdAt: now, updatedAt: now }
  await sync.apply(lease, page([{ kind: 'deck', value: deck, serverRevision: 1 }]), true)
  await library.updateDeck(deck.id, { name: 'Local edit' })
  const remote = { kind: 'deck' as const, value: { ...deck, name: 'Other edit', revision: 2 }, serverRevision: 2 }
  await sync.apply(lease, page([remote], 1), false)
  expect((await database.decks.get(deck.id))?.name).toBe('Local edit')
  const batch = await sync.batch(lease)
  const op = batch[0]
  await sync.acknowledge(lease, batch, { schemaVersion: 1,
    results: [{ opId: op.opId, status: 'conflict', reason: 'Changed', remote }] })
  await sync.release(lease, true)
  await sync.resolve(op.opId, 'local')
  expect(await database.client_outbox.get(op.opId)).toBeDefined()
  expect(await database.sync_issues.get(op.opId)).toMatchObject({ status: 'resolved' })
  await sync.acquire(owner, origin, lease)
  expect(await sync.batch(lease)).toMatchObject([{ baseServerRevision: 2, payload: { name: 'Local edit' } }])
})

test('applies a server spelling swap atomically and can explicitly adopt the server version', async () => {
  const deck = { id: 'deck', name: 'Original', revision: 1, createdAt: now, updatedAt: now }
  const a = { id: 'a', deckId: deck.id, term: 'one', normalizedTerm: 'one', meaning: '一',
    revision: 1, createdAt: now, updatedAt: now }
  const b = { ...a, id: 'b', term: 'two', normalizedTerm: 'two', meaning: '二' }
  await sync.apply(lease, page([{ kind: 'deck', value: deck, serverRevision: 1 },
    { kind: 'entry', value: a, serverRevision: 1 }, { kind: 'entry', value: b, serverRevision: 1 }]), true)
  const changeA = { kind: 'entry' as const, value: { ...a, term: 'two', normalizedTerm: 'two', revision: 3 }, serverRevision: 3 }
  const changeB = { kind: 'entry' as const, value: { ...b, term: 'one', normalizedTerm: 'one', revision: 2 }, serverRevision: 2 }
  await sync.apply(lease, page([changeB, changeA], 3), false)
  expect(await database.entries.get(a.id)).toMatchObject({ term: 'two', activeTerm: 'two' })
  expect(await database.entries.get(b.id)).toMatchObject({ term: 'one', activeTerm: 'one' })
  await library.updateEntry(deck.id, a.id, { term: 'two', meaning: '本地' })
  const ops = await sync.batch(lease)
  const latest = { ...changeA, value: { ...changeA.value, meaning: '服务端', revision: 4 }, serverRevision: 4 }
  await sync.acknowledge(lease, ops, { schemaVersion: 1,
    results: [{ opId: ops[0].opId, status: 'conflict', reason: 'Changed', remote: latest }] })
  await sync.release(lease, true)
  await sync.resolve(ops[0].opId, 'server')
  expect(await database.entries.get(a.id)).toMatchObject({ meaning: '服务端', serverRevision: 4 })
  expect(await database.client_outbox.get(ops[0].opId)).toBeDefined()
  expect((await sync.status()).pending).toBe(0)
})
