import type { LibraryChange, OutboxOperation } from '../../../shared/contracts/library'
import { SYNC_VERSION, stableJson, type LibrarySnapshot, type PushResponse, type SyncPage } from '../../../shared/contracts/sync'
import { cleanEntry, normalizeTerm } from '../../../shared/domain/library'
import type { ReviewEvent } from '../../../shared/domain/review'
import { db, type LexynLocalDatabase, type OutboxEntry } from '../../db/local'
import { appendOutboxOperations, deckSnapshot, entrySnapshot } from '../library/repository'
import type { SyncShadow, SyncState } from './types'

const leaseTime = 45_000
const batchSize = 20

export class SyncError extends Error {}

export function isOperation(row: OutboxEntry): row is OutboxOperation & { operationId: string } {
  return 'opId' in row && row.operationId === row.opId && 'schemaVersion' in row && row.schemaVersion === 1
    && 'kind' in row && typeof row.kind === 'string' && 'sequence' in row && Number.isSafeInteger(row.sequence)
}

function entityKey(op: OutboxOperation) {
  return op.kind.split('.')[0] + ':' + op.entityId
}

function originalReview({ effectiveReviewedAt: _, ...event }: ReviewEvent) {
  return event
}

export function createSyncStore(database: LexynLocalDatabase) {
  const { sync_state, sync_shadows, sync_issues, sync_meta, client_outbox, decks, entries,
    learn_progress, practice_events, review_events, review_cards, learn_sessions, preferences } = database
  const projectionTables = [sync_state, sync_shadows, sync_issues, client_outbox, decks, entries, learn_sessions, review_cards]
  const pullTables = [...projectionTables, learn_progress, practice_events, review_events, preferences]

  async function currentState() {
    const state = await sync_state.get('state')
    if (!state) throw new SyncError('Local synchronization is not initialized.')
    return state
  }

  async function requireLease(leaseId: string) {
    const state = await currentState()
    if (state.leaseId !== leaseId || (state.leaseUntil ?? 0) <= Date.now()) {
      throw new SyncError('Another tab is synchronizing. Try again shortly.')
    }
    return state
  }

  async function pending() {
    const [rows, issues] = await Promise.all([client_outbox.orderBy('sequence').toArray(), sync_issues.toArray()])
    const resolved = new Set(issues.filter(({ status }) => status === 'resolved').map(({ opId }) => opId))
    return { operations: rows.filter(isOperation).filter(({ opId }) => !resolved.has(opId)), issues }
  }

  async function shadow(key: string, seq: number, record: NonNullable<SyncShadow['record']>) {
    const previous = await sync_shadows.get(key)
    if ((previous?.seq ?? 0) >= seq) return
    await sync_shadows.put({ ...previous, key, seq, dirty: 1, record })
  }

  async function applyLibrary(remote: LibrarySnapshot) {
    if (remote.kind === 'deck') {
      const local = await decks.get(remote.value.id)
      if ((local?.serverRevision ?? 0) > remote.serverRevision) return true
      const changed = !local || stableJson({ ...deckSnapshot(local), revision: remote.value.revision }) !== stableJson(remote.value)
      await decks.put({ ...remote.value, serverRevision: remote.serverRevision,
        revision: local ? local.revision + Number(changed) : remote.value.revision })
      if (remote.value.archivedAt !== undefined) {
        await learn_sessions.where('deckId').equals(remote.value.id).and(({ status }) => status === 'active')
          .modify({ status: 'paused', updatedAt: Date.now() })
      }
      return true
    }
    const { value } = remote
    const local = await entries.get(value.id)
    if ((local?.serverRevision ?? 0) > remote.serverRevision) return true
    const activeTerm = value.deletedAt === undefined ? value.normalizedTerm : undefined
    if (activeTerm !== undefined) {
      const collision = await entries.where('[deckId+activeTerm]').equals([value.deckId, activeTerm]).first()
      if (collision && collision.id !== value.id) return false
    }
    const changed = !local || stableJson({ ...entrySnapshot(local), revision: value.revision }) !== stableJson(value)
    await entries.put({ ...value, activeTerm, serverRevision: remote.serverRevision,
      revision: local ? local.revision + Number(changed) : value.revision })
    return true
  }

  async function applyShadows(cursor: number) {
    const { operations } = await pending()
    const waiting = new Set(operations.map(entityKey))
    const dirty = await sync_shadows.where('dirty').equals(1).toArray()
    const ready = dirty.filter((row) => row.record && !waiting.has(row.key) && (row.ackThrough ?? 0) <= cursor)
    const wordChanges = new Map<string, { shadow: SyncShadow; blocker?: string }>()
    for (const row of ready) {
      if (row.record?.kind !== 'entry') continue
      const { value, serverRevision } = row.record
      const local = await entries.get(value.id)
      if ((local?.serverRevision ?? 0) > serverRevision) continue
      const collision = value.deletedAt === undefined
        ? await entries.where('[deckId+activeTerm]').equals([value.deckId, value.normalizedTerm]).first() : undefined
      wordChanges.set(value.id, { shadow: row, blocker: collision?.id !== value.id ? collision?.id : undefined })
    }
    // Resolve term moves as one set so swaps do not deadlock on the unique index.
    const blocked = new Set<SyncShadow>()
    let changed = true
    while (changed) {
      changed = false
      for (const [id, { shadow: row, blocker }] of wordChanges) {
        if (!blocker || wordChanges.has(blocker)) continue
        wordChanges.delete(id)
        blocked.add(row)
        changed = true
      }
    }
    for (const id of wordChanges.keys()) await entries.update(id, { activeTerm: undefined })
    for (const row of ready) {
      if (!row.record || blocked.has(row)) continue
      if (row.record.kind === 'card') await review_cards.put(row.record.value)
      else if (!await applyLibrary(row.record)) throw new SyncError('The server returned conflicting word spellings.')
      await sync_shadows.put({ ...row, dirty: 0, ackThrough: undefined })
    }
  }

  async function recomputeProgress(entryId: string) {
    const completed = await practice_events.where('entryId').equals(entryId).and(({ outcome }) => outcome === 'completed').toArray()
    if (!completed.length) return
    let first = Infinity
    let last = -Infinity
    for (const { completedAt } of completed) {
      first = Math.min(first, completedAt)
      last = Math.max(last, completedAt)
    }
    await learn_progress.put({ entryId, firstCompletedAt: first, lastPracticedAt: last, completedCount: completed.length })
  }

  async function retryDependents(op: OutboxOperation) {
    if (op.kind !== 'deck.create' && op.kind !== 'entry.create') return
    const code = op.kind === 'deck.create' ? 'MISSING_DECK' : 'MISSING_ENTRY'
    const issues = await sync_issues.filter((issue) => issue.code === code && issue.status !== 'resolved').toArray()
    for (const issue of issues) {
      const dependent = await client_outbox.get(issue.opId)
      if (!dependent || !isOperation(dependent)) continue
      if (code === 'MISSING_DECK' && 'deckId' in dependent.payload && dependent.payload.deckId === op.entityId
        || code === 'MISSING_ENTRY' && 'entryId' in dependent.payload && dependent.payload.entryId === op.entityId) {
        await sync_issues.delete(issue.opId)
      }
    }
  }

  return {
    initialize: () => database.transaction('rw', sync_state, async () => {
      const existing = await sync_state.get('state')
      if (existing) return existing
      const state: SyncState = { key: 'state', deviceId: crypto.randomUUID(), cursor: 0, bootstrapped: false }
      await sync_state.add(state)
      return state
    }),

    acquire: (ownerId: string, origin: string, leaseId: string, generation?: string) => database.transaction('rw', sync_state, async () => {
      const state = await currentState()
      if (state.ownerId && (state.ownerId !== ownerId || state.origin !== origin)) {
        throw new SyncError('This browser’s data is bound to a different Owner or server. Use a separate browser profile for that account.')
      }
      if (state.ownerId && state.generation !== generation) {
        throw new SyncError('The server was restored. Keep this browser’s saved data and use a separate browser profile to sync.')
      }
      const now = Date.now()
      if (state.leaseId && (state.leaseUntil ?? 0) > now) return undefined
      const updated = { ...state, ownerId, origin, generation, leaseId, leaseUntil: now + leaseTime }
      await sync_state.put(updated)
      return updated
    }),

    renew: (leaseId: string) => database.transaction('rw', sync_state, async () => {
      const state = await requireLease(leaseId)
      const updated = { ...state, leaseUntil: Date.now() + leaseTime }
      await sync_state.put(updated)
      return updated
    }),

    release: (leaseId: string, success: boolean) => database.transaction('rw', sync_state, async () => {
      const state = await currentState()
      if (state.leaseId !== leaseId) return
      await sync_state.put({ ...state, leaseId: undefined, leaseUntil: undefined,
        lastSuccessAt: success ? Date.now() : state.lastSuccessAt })
    }),

    batch: (leaseId: string) => database.transaction('r', [sync_state, client_outbox, sync_issues], async () => {
      await requireLease(leaseId)
      const { operations, issues } = await pending()
      const held = new Set(issues.filter(({ status }) => status !== 'resolved').map(({ opId }) => opId))
      const blocked = new Set(issues.filter(({ status }) => status === 'conflict').map(({ entityKey }) => entityKey))
      return operations.filter((op) => !held.has(op.opId) && !blocked.has(entityKey(op))).slice(0, batchSize)
    }),

    acknowledge: (leaseId: string, sent: OutboxOperation[], response: PushResponse) =>
      database.transaction('rw', [sync_state, sync_shadows, sync_issues, client_outbox], async () => {
        await requireLease(leaseId)
        if (response.schemaVersion !== SYNC_VERSION || !Array.isArray(response.results) || response.results.length !== sent.length) {
          throw new SyncError('The server returned an invalid acknowledgement.')
        }
        for (const [index, result] of response.results.entries()) {
          const op = sent[index]
          if (result.opId !== op.opId) throw new SyncError('The server acknowledged a different operation.')
          if (result.status === 'accepted' || result.status === 'already_applied') {
            const seq = result.serverSeq
            if (seq !== null && (!Number.isSafeInteger(seq) || seq < 1)) throw new SyncError('Invalid acknowledgement sequence.')
            if (op.kind !== 'practice.create' && seq !== null) {
              const key = entityKey(op)
              const previous = await sync_shadows.get(key)
              await sync_shadows.put({ ...previous, key, seq: previous?.seq ?? 0, dirty: 1,
                ackThrough: Math.max(previous?.ackThrough ?? 0, seq) })
            }
            await client_outbox.delete(op.opId)
            await sync_issues.delete(op.opId)
            await retryDependents(op)
          } else if (result.status === 'conflict' || result.status === 'rejected') {
            await sync_issues.put({ ...result, entityKey: entityKey(op) })
          } else {
            throw new SyncError('The server returned an unknown acknowledgement status.')
          }
        }
      }),

    apply: (leaseId: string, page: SyncPage, bootstrap: boolean) => database.transaction('rw', pullTables, async () => {
      const state = await requireLease(leaseId)
      if (page.schemaVersion !== SYNC_VERSION || page.ownerId !== state.ownerId || page.generation !== state.generation || !Array.isArray(page.changes)
        || !Number.isSafeInteger(page.serverSeq) || !Number.isSafeInteger(page.nextCursor)
        || page.nextCursor < state.cursor || page.nextCursor > page.serverSeq
        || (bootstrap && state.through !== undefined && page.serverSeq !== state.through)) {
        throw new SyncError('The server returned an invalid synchronization cursor.')
      }
      let previous = state.cursor
      const practiced = new Set<string>()
      for (const { seq, record } of page.changes) {
        if (!Number.isSafeInteger(seq) || seq !== previous + 1 || seq > page.nextCursor) {
          throw new SyncError('A synchronization change is missing or out of order.')
        }
        previous = seq
        switch (record.kind) {
          case 'deck': case 'entry':
            await shadow(record.kind + ':' + record.value.id, seq, record)
            break
          case 'practice': {
            const local = await practice_events.get(record.event.id)
            if (local && stableJson(local) !== stableJson(record.event)) throw new SyncError('A practice event ID has different content.')
            if (!local) await practice_events.add(record.event)
            practiced.add(record.event.entryId)
            break
          }
          case 'review': {
            const local = await review_events.get(record.event.id)
            if (local && stableJson(originalReview(local)) !== stableJson(originalReview(record.event))) {
              throw new SyncError('A review event ID has different content.')
            }
            await review_events.put(record.event)
            await shadow('review:' + record.card.id, seq, { kind: 'card', value: record.card })
            break
          }
          default: throw new SyncError('The server returned an unknown synchronization change.')
        }
      }
      if (previous !== page.nextCursor || (page.hasMore !== (page.nextCursor < page.serverSeq))) {
        throw new SyncError('The synchronization page ended at an unexpected cursor.')
      }
      if (bootstrap && state.cursor === 0 && page.restoredDailyNewWords !== undefined) {
        const value = page.restoredDailyNewWords
        if (!Number.isInteger(value) || value < 1 || value > 100) throw new SyncError('Invalid restored daily new words limit.')
        if (!await preferences.get('daily-new-words')) await preferences.add({ key: 'daily-new-words', value })
      }
      for (const entryId of practiced) await recomputeProgress(entryId)
      await applyShadows(page.nextCursor)
      await sync_state.put({
        ...state, cursor: page.nextCursor, bootstrapped: state.bootstrapped || (bootstrap && !page.hasMore),
        through: bootstrap && page.hasMore ? page.serverSeq : undefined,
      })
    }),

    status: () => database.transaction('r', [sync_state, client_outbox, sync_issues, sync_shadows, decks, entries], async () => {
      const state = await sync_state.get('state')
      const { operations, issues } = await pending()
      const unresolved = issues.filter(({ status }) => status !== 'resolved')
      const rows = new Map(operations.map((op) => [op.opId, op]))
      const legacy = await client_outbox.filter((row) => !isOperation(row)).count()
      const waiting = new Set(operations.map(entityKey))
      const hidden = await sync_shadows.where('dirty').equals(1).and((row) => !!row.record
        && !waiting.has(row.key) && (row.ackThrough ?? 0) <= (state?.cursor ?? 0)).count()
      const activeIssues = []
      for (const issue of unresolved) {
        const operation = rows.get(issue.opId)
        if (!operation) continue
        const deck = issue.status === 'conflict' && issue.entityKey.startsWith('deck:')
          ? await decks.get(operation.entityId) : undefined
        const word = issue.status === 'conflict' && issue.entityKey.startsWith('entry:')
          ? await entries.get(operation.entityId) : undefined
        const shadow = (await sync_shadows.get(issue.entityKey))?.record
        const remote = shadow && shadow.kind !== 'card' && shadow.serverRevision >= (issue.remote?.serverRevision ?? 0)
          ? shadow : issue.remote
        activeIssues.push({ ...issue, operation, remote,
          local: deck ? deckSnapshot(deck) : word ? entrySnapshot(word) : operation.payload })
      }
      return { state, pending: operations.length + legacy, legacy, hidden, issues: activeIssues }
    }),

    retryRejected: () => sync_issues.where('status').equals('rejected').delete(),

    resolve: (opId: string, choice: 'server' | 'local', alternateTerm?: string) =>
      database.transaction('rw', [...projectionTables, sync_meta], async () => {
        const state = await currentState()
        if (state.leaseId && (state.leaseUntil ?? 0) > Date.now()) throw new SyncError('Wait for the current sync to finish.')
        const issue = await sync_issues.get(opId)
        const operation = await client_outbox.get(opId)
        if (issue?.status !== 'conflict' || !operation || !isOperation(operation)) return
        const { entityId } = operation
        const key = issue.entityKey
        const shadowRow = await sync_shadows.get(key)
        const pulled = shadowRow?.record
        const remote = pulled && pulled.kind !== 'card' && pulled.serverRevision >= (issue.remote?.serverRevision ?? 0)
          ? pulled : issue.remote
        const now = Date.now()
        const related = (await pending()).operations.filter((op) => entityKey(op) === key)
        if (choice === 'server') {
          if (remote) {
            if (!await applyLibrary(remote)) throw new SyncError('Resolve the other local word with the same spelling first.')
          } else if (key.startsWith('entry:')) {
            await entries.update(entityId, { deletedAt: now, activeTerm: undefined })
          } else {
            await decks.update(entityId, { archivedAt: now })
          }
          if (shadowRow && remote === pulled) await sync_shadows.put({ ...shadowRow, dirty: 0 })
        } else {
          let change: LibraryChange
          if (key.startsWith('deck:')) {
            const local = await decks.get(entityId)
            if (!local) throw new SyncError('The local deck no longer exists.')
            const old = remote?.kind === 'deck' ? remote.value : undefined
            if (old?.archivedAt !== undefined && local.archivedAt !== undefined) {
              throw new SyncError('The server already archived this deck. Use the server version, then restore it to edit.')
            }
            if (!old && local.archivedAt !== undefined) throw new SyncError('Restore the local deck before submitting it.')
            const value = { ...local, createdAt: old?.createdAt ?? local.createdAt, updatedAt: Math.max(now, local.updatedAt, old?.createdAt ?? 0),
              revision: old ? local.revision + 1 : 1, serverRevision: remote?.serverRevision }
            await decks.put(value)
            change = { kind: !old ? 'deck.create' : old.archivedAt !== undefined ? 'deck.restore'
              : local.archivedAt !== undefined ? 'deck.archive' : 'deck.update', payload: deckSnapshot(value) }
          } else {
            const local = await entries.get(entityId)
            if (!local) throw new SyncError('The local word no longer exists.')
            const old = remote?.kind === 'entry' ? remote.value : undefined
            if ((!old || old.deletedAt !== undefined) && local.deletedAt !== undefined) {
              throw new SyncError('Use the server version, or restore the local word before submitting it.')
            }
            const cleaned = cleanEntry({ ...local, term: alternateTerm?.trim() || local.term })
            const normalizedTerm = normalizeTerm(cleaned.term)
            const activeTerm = local.deletedAt === undefined ? normalizedTerm : undefined
            if (activeTerm !== undefined) {
              const duplicate = await entries.where('[deckId+activeTerm]').equals([local.deckId, activeTerm]).first()
              if (duplicate && duplicate.id !== local.id) throw new SyncError('Choose a spelling not used by another local word.')
            }
            const value = { ...local, ...cleaned, normalizedTerm, activeTerm, createdAt: old?.createdAt ?? local.createdAt,
              termChangedAt: normalizedTerm !== local.normalizedTerm ? now : local.termChangedAt,
              updatedAt: Math.max(now, local.updatedAt, old?.createdAt ?? 0), revision: old ? local.revision + 1 : 1,
              serverRevision: remote?.serverRevision }
            await entries.put(value)
            change = { kind: !old ? 'entry.create' : old.deletedAt !== undefined ? 'entry.restore'
              : local.deletedAt !== undefined ? 'entry.delete' : 'entry.update', payload: entrySnapshot(value) }
          }
          await appendOutboxOperations(database, [{ ...change, baseServerRevision: remote?.serverRevision }], now)
        }
        for (const op of related) await sync_issues.put({ opId: op.opId, entityKey: key, status: 'resolved',
          reason: choice === 'local' ? 'Replaced by an explicit local resubmission.' : 'Resolved using the server version.' })
        await applyShadows(state.cursor)
      }),
  }
}

export const syncStore = createSyncStore(db)
