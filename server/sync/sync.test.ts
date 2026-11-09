import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { OutboxOperation } from '../../shared/contracts/library.ts'
import type { PushResponse, SyncPage, SyncRecord } from '../../shared/contracts/sync.ts'
import type { Deck, Entry } from '../../shared/domain/library.ts'
import type { PracticeEvent } from '../../shared/domain/learning.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewEvent, type ReviewRating } from '../../shared/domain/review.ts'
import { createReviewScheduler, rebuildCardFromEvents, schedulerConfigSnapshot, schedulerGrades,
  serializeCard, serializeRevlog } from '../../shared/srs/scheduler.ts'
import { createApp } from '../app.ts'
import { createAuth, initializeOwner } from '../auth/owner.ts'
import { migrate } from '../db/migrations/index.ts'

const origin = 'http://127.0.0.1:3000'
const password = 'integration-password-example'
const now = Date.UTC(2026, 0, 2)
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
let deviceA: string
let deviceB: string
let sequence: number

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  await initializeOwner(db, password)
  const login = await createAuth(db).login(password)
  if (login.status !== 'ok') throw new Error('Test login failed')
  headers = { Origin: origin, 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': login.ownerId,
    'Content-Type': 'application/json', Cookie: 'lexyn-session=' + login.token }
  app = createApp(db)
  deviceA = randomUUID()
  deviceB = randomUUID()
  sequence = 0
})

afterEach(() => { vi.restoreAllMocks(); db.close() })

function operation(
  kind: OutboxOperation['kind'], payload: Deck | Entry | PracticeEvent | ReviewEvent,
  baseRevision = 0, baseServerRevision?: number,
): OutboxOperation {
  const entityId = 'cardId' in payload ? payload.cardId : 'sessionId' in payload ? payload.entryId : payload.id
  return { kind, payload, opId: randomUUID(), schemaVersion: 1, entityId, sequence: ++sequence,
    createdAt: now, baseRevision, baseServerRevision } as OutboxOperation
}

const deck = (name = 'Systems'): Deck => ({ id: randomUUID(), name, revision: 1, createdAt: now, updatedAt: now })
function entry(deckId: string, term = 'deadlock'): Entry {
  return { id: randomUUID(), deckId, term, normalizedTerm: term, meaning: '死锁', revision: 1, createdAt: now, updatedAt: now }
}

async function push(operations: OutboxOperation[], deviceId = deviceA) {
  return app.request('/api/sync/push', { method: 'POST', headers,
    body: JSON.stringify({ schemaVersion: 1, deviceId, cursor: 0, operations }) })
}

const result = async (ops: OutboxOperation[], device?: string) => (await (await push(ops, device)).json() as PushResponse).results
const page = async (path: string) => await (await app.request(path, { headers })).json() as SyncPage

test('protects synchronization and uses a fixed bootstrap watermark over 1000 operations', async () => {
  const anonymous = { 'X-Lexyn-Client': '1' }
  expect((await app.request('/api/bootstrap', { headers: anonymous })).status).toBe(401)
  expect((await app.request('/api/sync/pull', { headers: anonymous })).status).toBe(401)
  expect((await app.request('/api/sync/push', { method: 'POST', headers: { ...anonymous, Origin: origin } })).status).toBe(401)
  expect((await app.request('/api/bootstrap', { headers: { ...headers, 'X-Lexyn-Owner': randomUUID() } })).status).toBe(409)
  const ops = Array.from({ length: 1005 }, (_, index) => operation('deck.create', deck('Deck ' + index)))
  for (let index = 0; index < ops.length; index += 32) {
    expect((await result(ops.slice(index, index + 32))).every(({ status }) => status === 'accepted')).toBe(true)
  }
  const first = await page('/api/bootstrap?limit=81')
  const extra = operation('deck.create', deck('Written during bootstrap'))
  await result([extra], deviceB)
  let cursor = first.nextCursor
  const sequences = first.changes.map(({ seq }) => seq)
  while (cursor < first.serverSeq) {
    const next = await page(`/api/bootstrap?after=${cursor}&through=${first.serverSeq}&limit=81`)
    sequences.push(...next.changes.map(({ seq }) => seq))
    cursor = next.nextCursor
  }
  expect(sequences).toEqual(ops.map((_, index) => index + 1))
  expect(await page(`/api/sync/pull?after=${cursor}`)).toMatchObject({
    nextCursor: 1006, hasMore: false, changes: [{ seq: 1006, record: { value: extra.payload } }],
  })
})

test('deduplicates operations, rejects altered retries and rolls back data and receipts together', async () => {
  const record = deck()
  const op = operation('deck.create', record)
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON sync_operations BEGIN SELECT RAISE(ABORT, 'test failure'); END")
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await push([op])).status).toBe(500)
  for (const table of ['decks', 'sync_operations', 'sync_changes']) {
    expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
  }
  expect(log).toHaveBeenCalledWith('Request failed')
  db.exec('DROP TRIGGER fail_receipt')
  expect(await result([op])).toMatchObject([{ status: 'accepted', serverSeq: 1 }])
  expect(await result([op])).toMatchObject([{ status: 'already_applied', serverSeq: 1 }])
  expect(await result([op])).toMatchObject([{ status: 'already_applied', serverSeq: 1 }])
  expect(await result([{ ...op, payload: { ...record, name: 'Altered' } } as OutboxOperation]))
    .toMatchObject([{ status: 'rejected' }])
  expect((await page('/api/sync/pull')).changes).toHaveLength(1)
})

test('accepts the legacy chain only on its own base and reports edit and restore conflicts', async () => {
  const parent = deck()
  const word = entry(parent.id)
  await result([operation('deck.create', parent), operation('entry.create', word)])
  expect(await result([operation('entry.update', { ...word, meaning: '旧释义', revision: 2 }, 1)]))
    .toMatchObject([{ status: 'accepted' }])
  const fresh = { ...word, meaning: '新释义', revision: 3 }
  await result([operation('entry.update', fresh, 2, 2)], deviceB)
  const stale = operation('entry.update', { ...word, meaning: '过期释义', revision: 3 }, 2)
  const single = await push([stale])
  expect(single.status).toBe(409)
  expect(await single.json()).toMatchObject({ results: [{ status: 'conflict', remote: { value: fresh, serverRevision: 3 } }] })
  const removed = { ...fresh, deletedAt: now, revision: 4 }
  await result([operation('entry.delete', removed, 3, 3)], deviceB)
  const replacement = entry(parent.id)
  await result([operation('entry.create', replacement)], deviceB)
  const restore = operation('entry.restore', { ...fresh, revision: 5 }, 4, 4)
  expect(await result([restore, operation('deck.create', deck('Unrelated'))], deviceB)).toMatchObject([
    { status: 'conflict', blocking: { kind: 'entry', value: { id: replacement.id } } }, { status: 'accepted' },
  ])
})

test('practice events aggregate from distinct IDs and ignore skipped attempts', async () => {
  const parent = deck()
  const word = entry(parent.id)
  await result([operation('deck.create', parent), operation('entry.create', word)])
  const event: PracticeEvent = {
    id: randomUUID(), sessionId: randomUUID(), deckId: parent.id, entryId: word.id, mode: 'copy',
    outcome: 'completed', attempts: 1, assisted: false, firstTryCorrect: true, startedAt: now, completedAt: now + 300,
  }
  await result([operation('practice.create', event)])
  expect(await result([operation('practice.create', event)], deviceB)).toMatchObject([{ status: 'already_applied' }])
  const early = { ...event, id: randomUUID(), completedAt: now + 50 }
  const skipped = { ...event, id: randomUUID(), outcome: 'skipped' as const, completedAt: now + 500 }
  await result([operation('practice.create', early), operation('practice.create', skipped)], deviceB)
  const practice = (await page('/api/sync/pull')).changes.map(({ record }) => record)
    .filter(({ kind }) => kind === 'practice')
  expect(practice).toHaveLength(3)
  expect(practice[1]).toMatchObject({ progress: { firstCompletedAt: now + 50, lastPracticedAt: now + 300, completedCount: 2 } })
  expect(practice[2]).not.toHaveProperty('progress')
})

test.each([false, true])('replays both devices in deterministic order (reverse arrival: %s)', async (reverse) => {
  const parent = deck()
  const word = entry(parent.id)
  await result([operation('deck.create', parent), operation('entry.create', word)])
  const engine = await createReviewScheduler()
  const config = schedulerConfigSnapshot(engine)
  const cardId = reviewCardId(word.id)
  function make(rating: ReviewRating, reviewedAt: number): ReviewEvent {
    const date = new Date(reviewedAt)
    const { card, revlog } = engine.review({ card: engine.newCard({ now: date, cardId }), grade: schedulerGrades[rating], now: date })
    return {
      id: randomUUID(), entryId: word.id, deckId: parent.id, cardId, direction: REVIEW_DIRECTION, sessionId: randomUUID(),
      rating, reviewedAt, schedulerModel: 'FSRS-7', schedulerConfigVersion: config.version, schedulerConfigSnapshot: config,
      resultingCardState: serializeCard(card), schedulerRevlog: serializeRevlog(revlog, rating),
    }
  }
  const a = make('good', now)
  const b = make('again', now + 1)
  const bad = { ...make('easy', now), schedulerConfigVersion: 'invalid' }
  expect(await result([operation('review.create', bad)])).toMatchObject([{ status: 'rejected' }])
  for (const event of reverse ? [b, a] : [a, b]) {
    const op = operation('review.create', event)
    const device = event === a ? deviceA : deviceB
    expect(await result([op], device)).toMatchObject([{ status: 'accepted' }])
    expect(await result([op], device)).toMatchObject([{ status: 'already_applied' }])
  }
  const future = make('hard', Date.now() + 86_400_000)
  expect(await result([operation('review.create', future)], deviceB)).toMatchObject([{ status: 'accepted' }])
  const reviews = (await page('/api/sync/pull')).changes.map(({ record }) => record).filter((record): record is Extract<SyncRecord, { kind: 'review' }> => record.kind === 'review')
  expect(reviews.map(({ event }) => event.id).sort()).toEqual([a.id, b.id, future.id].sort())
  expect(reviews.find(({ event }) => event.id === a.id)?.event).toMatchObject(a)
  expect(reviews.find(({ event }) => event.id === b.id)?.event).toMatchObject(b)
  expect(reviews[1].card.schedulerState).toEqual(await rebuildCardFromEvents([a, b]))
  expect(reviews[2].event.reviewedAt).toBe(future.reviewedAt)
  expect(reviews[2].event.effectiveReviewedAt).toBeLessThan(future.reviewedAt)
  expect(reviews[2].card.schedulerState).toEqual(await rebuildCardFromEvents(reviews.map(({ event }) => event)))
  expect(reviews[2].card.schedulerState.stabilityFast).toBeGreaterThan(0)
})
