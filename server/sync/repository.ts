import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { LibraryOperation, OutboxOperation, PracticeOperation, ReviewOperation } from '../../shared/contracts/library.ts'
import {
  SYNC_VERSION, stableJson, type LibrarySnapshot, type PushResult, type SyncPage, type SyncRecord,
} from '../../shared/contracts/sync.ts'
import type { LearnProgress } from '../../shared/domain/learning.ts'
import type { Deck, Entry } from '../../shared/domain/library.ts'
import type { ReviewCard, ReviewEvent } from '../../shared/domain/review.ts'
import { rebuildCardFromEvents } from '../../shared/srs/scheduler.ts'

interface EntityRow {
  body: string
  revision: number
  device_id: string
  local_revision: number
  base_revision: number | null
}

type Outcome =
  | { status: 'accepted'; record: SyncRecord }
  | { status: 'already_applied' }
  | Omit<Extract<PushResult, { status: 'conflict' }>, 'opId'>
  | Omit<Extract<PushResult, { status: 'rejected' }>, 'opId'>

const body = <T>(row: { body: string }) => JSON.parse(row.body) as T
const clockAllowance = 5 * 60 * 1000
const conflict = (reason: string, remote?: LibrarySnapshot, blocking?: LibrarySnapshot): Outcome =>
  ({ status: 'conflict', reason, remote, blocking })

export function createSyncRepository(db: Database.Database) {
  const watermark = () => (db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM sync_changes').get() as { seq: number }).seq

  function lookup(table: 'decks' | 'entries', id: string) {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as EntityRow | undefined
  }

  function snapshot(table: 'decks' | 'entries', row: EntityRow): LibrarySnapshot {
    return table === 'decks' ? { kind: 'deck', value: body<Deck>(row), serverRevision: row.revision }
      : { kind: 'entry', value: body<Entry>(row), serverRevision: row.revision }
  }

  function applyLibrary(op: LibraryOperation, deviceId: string, now: number): Outcome {
    const entry = 'deckId' in op.payload ? op.payload : undefined
    const table = entry ? 'entries' : 'decks'
    const current = lookup(table, op.entityId)
    const remote = current && snapshot(table, current)
    const create = op.kind.endsWith('.create')
    if (create && current) return conflict('This ID already exists on the server.', remote)
    if (!create && !current) return conflict('The server has no record at this ID.')
    if (current && op.baseServerRevision !== current.revision
      && !(current.device_id === deviceId && current.local_revision === op.baseRevision
        && current.base_revision === (op.baseServerRevision ?? null))) {
      return conflict('This record changed on another device.', remote)
    }
    if (remote && op.payload.createdAt !== remote.value.createdAt) {
      return conflict('The record creation time differs from the server.', remote)
    }
    const revision = (current?.revision ?? 0) + 1
    const version = [revision, deviceId, op.payload.revision, op.baseServerRevision ?? null] as const
    if (entry) {
      if (remote?.kind === 'entry' && remote.value.deckId !== entry.deckId) {
        return { status: 'rejected', reason: 'An entry cannot move to another deck.' }
      }
      const deck = lookup('decks', entry.deckId)
      if (!deck) return { status: 'conflict', code: 'MISSING_DECK', reason: 'The parent deck is not synchronized yet.', remote }
      if (body<Deck>(deck).archivedAt !== undefined) {
        return conflict('Restore the parent deck before updating this word.', remote, snapshot('decks', deck))
      }
      if ((remote?.kind === 'entry' && remote.value.deletedAt !== undefined) !== (op.kind === 'entry.restore')) {
        return conflict('The word removal state changed.', remote)
      }
      const activeTerm = entry.deletedAt === undefined ? entry.normalizedTerm : null
      if (activeTerm !== null) {
        const duplicate = db.prepare('SELECT * FROM entries WHERE deck_id = ? AND active_term = ? AND id != ?')
          .get(entry.deckId, activeTerm, entry.id) as EntityRow | undefined
        if (duplicate) return conflict('Another active word uses this spelling.', remote, snapshot('entries', duplicate))
      }
      const termChangedAt = remote?.kind === 'entry' && remote.value.normalizedTerm !== entry.normalizedTerm
        ? now : remote?.kind === 'entry' ? remote.value.termChangedAt : entry.termChangedAt
      const value = { ...entry, termChangedAt }
      db.prepare(`INSERT INTO entries (id, deck_id, active_term, body, revision, device_id, local_revision, base_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active_term=excluded.active_term,
        body=excluded.body, revision=excluded.revision, device_id=excluded.device_id,
        local_revision=excluded.local_revision, base_revision=excluded.base_revision`)
        .run(entry.id, entry.deckId, activeTerm, stableJson(value), ...version)
      return { status: 'accepted', record: { kind: 'entry', value, serverRevision: revision } }
    }
    if ((remote?.kind === 'deck' && remote.value.archivedAt !== undefined) !== (op.kind === 'deck.restore')) {
      return conflict('The deck archive state changed.', remote)
    }
    const value = op.payload as Deck
    db.prepare(`INSERT INTO decks (id, body, revision, device_id, local_revision, base_revision)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=excluded.revision,
      device_id=excluded.device_id, local_revision=excluded.local_revision, base_revision=excluded.base_revision`)
      .run(value.id, stableJson(value), ...version)
    return { status: 'accepted', record: { kind: 'deck', value, serverRevision: revision } }
  }

  function duplicateEvent(table: 'practice_events' | 'review_events', event: { id: string }) {
    const existing = db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(event.id) as { body: string } | undefined
    if (!existing) return undefined
    return (existing.body === stableJson(event) ? { status: 'already_applied' }
      : { status: 'rejected', reason: 'This event ID already has different content.' }) satisfies Outcome
  }

  function validStudyEntry(event: { entryId: string; deckId: string }) {
    const entry = lookup('entries', event.entryId)
    return entry && body<Entry>(entry).deckId === event.deckId
  }

  function applyPractice(op: PracticeOperation, deviceId: string): Outcome {
    const event = op.payload
    const duplicate = duplicateEvent('practice_events', event)
    if (duplicate) return duplicate
    if (!validStudyEntry(event)) return { status: 'rejected', code: 'MISSING_ENTRY', reason: 'The practice word is not synchronized.' }
    db.prepare('INSERT INTO practice_events VALUES (?, ?, ?, ?)').run(event.id, event.entryId, deviceId, stableJson(event))
    let progress: LearnProgress | undefined
    if (event.outcome === 'completed') {
      const row = db.prepare('SELECT body FROM learn_progress WHERE entry_id = ?').get(event.entryId) as { body: string } | undefined
      const old = row && body<LearnProgress>(row)
      progress = {
        entryId: event.entryId,
        firstCompletedAt: Math.min(old?.firstCompletedAt ?? event.completedAt, event.completedAt),
        lastPracticedAt: Math.max(old?.lastPracticedAt ?? event.completedAt, event.completedAt),
        completedCount: (old?.completedCount ?? 0) + 1,
      }
      db.prepare('INSERT INTO learn_progress VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET body=excluded.body')
        .run(event.entryId, stableJson(progress))
    }
    return { status: 'accepted', record: { kind: 'practice', event, progress } }
  }

  const getCard = (id: string) => {
    const row = db.prepare('SELECT body FROM review_cards WHERE id = ?').get(id) as { body: string } | undefined
    return row && body<ReviewCard>(row)
  }

  async function prepareReview(event: ReviewEvent, now: number) {
    if (duplicateEvent('review_events', event) || !validStudyEntry(event)) return undefined
    const previous = getCard(event.cardId)
    const effectiveReviewedAt = event.reviewedAt > now + clockAllowance ? now : event.reviewedAt
    const received = { ...event, effectiveReviewedAt }
    const rows = db.prepare('SELECT body, effective_reviewed_at FROM review_events WHERE card_id = ? ORDER BY effective_reviewed_at, id')
      .all(event.cardId) as { body: string; effective_reviewed_at: number }[]
    const events = rows.map((row) => ({ ...body<ReviewEvent>(row), effectiveReviewedAt: row.effective_reviewed_at }))
    events.push(received)
    events.sort((a, b) => a.effectiveReviewedAt - b.effectiveReviewedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const state = (await rebuildCardFromEvents(events))!
    const last = events[events.length - 1]
    const card: ReviewCard = {
      id: event.cardId, entryId: event.entryId, deckId: event.deckId, direction: event.direction,
      revision: (previous?.revision ?? 0) + 1, lastEventId: last.id,
      createdAt: events[0].effectiveReviewedAt, updatedAt: now,
      schedulerConfigVersion: last.schedulerConfigVersion, schedulerState: state,
      dueAt: state.dueAt, scheduleStatus: state.scheduleStatus,
    }
    return { received, card }
  }

  type PreparedReview = Awaited<ReturnType<typeof prepareReview>>
  const retry = Symbol('projection changed')
  function applyReview(op: ReviewOperation, deviceId: string, prepared: PreparedReview): Outcome | typeof retry {
    const event = op.payload
    const duplicate = duplicateEvent('review_events', event)
    if (duplicate) return duplicate
    if (!validStudyEntry(event)) return { status: 'rejected', code: 'MISSING_ENTRY', reason: 'The review word is not synchronized.' }
    if (!prepared || (getCard(event.cardId)?.revision ?? 0) !== prepared.card.revision - 1) return retry
    const { received, card } = prepared
    db.prepare('INSERT INTO review_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, event.entryId, event.cardId, deviceId, received.effectiveReviewedAt, stableJson(event))
    db.prepare(`INSERT INTO review_cards VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, body=excluded.body`)
      .run(card.id, card.entryId, card.direction, card.revision, stableJson(card))
    return { status: 'accepted', record: { kind: 'review', event: received, card } }
  }

  async function push(op: OutboxOperation, deviceId: string, now = Date.now()): Promise<PushResult> {
    const { operationId: _, ...content } = op as OutboxOperation & { operationId?: string }
    const digest = createHash('sha256').update(stableJson(content)).digest('hex')
    function receipt(): PushResult | undefined {
      const existing = db.prepare('SELECT * FROM sync_operations WHERE id = ?').get(op.opId) as
        { request_hash: string; device_id: string; server_seq: number | null; applied: number } | undefined
      if (!existing) return undefined
      if (existing.request_hash !== digest || existing.device_id !== deviceId) {
        return { opId: op.opId, status: 'rejected', reason: 'This operation ID already has different content or origin.' }
      }
      if (existing.applied) return { opId: op.opId, status: 'already_applied', serverSeq: existing.server_seq }
    }
    const prior = receipt()
    if (prior) return prior
    for (let attempt = 0; attempt < 4; attempt++) {
      const prepared = op.kind === 'review.create' ? await prepareReview(op.payload, now) : undefined
      const result = db.transaction((): PushResult | typeof retry => {
        const previous = receipt()
        if (previous) return previous
        const outcome = op.kind === 'practice.create' ? applyPractice(op, deviceId)
          : op.kind === 'review.create' ? applyReview(op, deviceId, prepared) : applyLibrary(op, deviceId, now)
        if (outcome === retry) return retry
        const seq = outcome.status === 'accepted'
          ? Number(db.prepare('INSERT INTO sync_changes (body) VALUES (?)').run(stableJson(outcome.record)).lastInsertRowid)
          : null
        const applied = outcome.status === 'accepted' || outcome.status === 'already_applied'
        db.prepare(`INSERT INTO sync_operations VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET applied=excluded.applied, server_seq=excluded.server_seq`)
          .run(op.opId, deviceId, digest, seq, applied ? 1 : 0)
        if (applied) return { opId: op.opId, status: outcome.status as 'accepted' | 'already_applied', serverSeq: seq }
        return { opId: op.opId, ...outcome } as PushResult
      }).immediate()
      if (result !== retry) return result
    }
    throw new Error('The review projection changed during synchronization.')
  }

  function registerDevice(id: string, ownerId: string, cursor: number, now = Date.now()) {
    db.prepare(`INSERT INTO devices VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE
      SET last_seen_at=excluded.last_seen_at, pull_cursor=max(pull_cursor, excluded.pull_cursor)`)
      .run(id, ownerId, now, cursor)
  }

  function page(ownerId: string, after: number, limit: number, through?: number): SyncPage | undefined {
    const head = watermark()
    const serverSeq = through ?? head
    if (serverSeq > head || after > serverSeq) return undefined
    const rows = db.prepare('SELECT seq, body FROM sync_changes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?')
      .all(after, serverSeq, limit + 1) as { seq: number; body: string }[]
    const hasMore = rows.length > limit
    const changes = rows.slice(0, limit).map((row) => ({ seq: row.seq, record: body<SyncRecord>(row) }))
    return { schemaVersion: SYNC_VERSION, ownerId, serverSeq, hasMore,
      nextCursor: hasMore ? changes[changes.length - 1].seq : serverSeq, changes }
  }

  return { push, page, registerDevice, watermark }
}
