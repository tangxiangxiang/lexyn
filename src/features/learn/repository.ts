import type { OutboxChange } from '../../../shared/contracts/library'
import type { DeckRecord, EntryRecord, LexynLocalDatabase, LearnProgressRecord, LearnSessionRecord } from '../../db/local'
import type { LearnMode, PracticeEvent } from '../../../shared/domain/learning'
import { dateKey, isSpellingCorrect } from '../../../shared/domain/learning'
import { appendOutboxOperations } from '../library/repository'

export interface LearnDailyState {
  quota: number
  completedToday: number
  day: string
  candidates: EntryRecord[]
  practiceCandidates: EntryRecord[]
  decks: DeckRecord[]
  activeSession?: LearnSessionRecord
}

export class LearnError extends Error {}

export function createLearnRepository(database: LexynLocalDatabase) {
  const { decks, entries, client_outbox, sync_meta, practice_events, learn_progress, learn_sessions } = database

  async function appendChanges(changes: OutboxChange[], now: number) {
    await appendOutboxOperations(database, changes, now)
  }

  const isOpen = (session: LearnSessionRecord) => session.status === 'active' || session.status === 'paused'
  const currentId = (session: LearnSessionRecord) => session.entryIds[session.currentIndex]
  const isUsable = (entry: EntryRecord | undefined, session: LearnSessionRecord): entry is EntryRecord =>
    !!entry && entry.deckId === session.deckId && entry.deletedAt === undefined

  function resetWord(session: LearnSessionRecord, index: number, now: number): LearnSessionRecord {
    const exhausted = index >= session.entryIds.length
    return {
      ...session,
      currentIndex: exhausted ? Math.max(0, session.entryIds.length - 1) : index,
      status: exhausted ? 'completed' : session.status,
      updatedAt: now, currentEntryStartedAt: now, currentAttempts: 0,
      currentFirstTryCorrect: undefined, currentAssisted: false, currentLastSubmitted: undefined,
    }
  }

  async function reconcile(session: LearnSessionRecord, now: number): Promise<LearnSessionRecord> {
    const deck = await decks.get(session.deckId)
    if (!deck) return { ...session, status: 'abandoned', updatedAt: now }
    if (deck.archivedAt !== undefined) {
      return session.status === 'paused' ? session : { ...session, status: 'paused', updatedAt: now }
    }
    if (isUsable(await entries.get(currentId(session) ?? ''), session)) return session

    // Preserve the processed prefix and discard only unusable words at the head of the remaining queue.
    const pending = await entries.bulkGet(session.entryIds.slice(session.currentIndex))
    const next = pending.findIndex((entry) => isUsable(entry, session))
    const entryIds = session.entryIds.slice(0, session.currentIndex)
      .concat(next < 0 ? [] : session.entryIds.slice(session.currentIndex + next))
    return resetWord({ ...session, entryIds }, session.currentIndex, now)
  }

  return {
    getDailyState: async (deckId: string | undefined, now = Date.now()): Promise<LearnDailyState> =>
      database.transaction('r', [decks, entries, learn_progress, learn_sessions, practice_events, database.preferences], async () => {
        const configuredQuota = await database.preferences.get('daily-new-words')
        const rawQuota = configuredQuota?.value
        const quota = typeof rawQuota === 'number' && Number.isInteger(rawQuota) && rawQuota >= 1 && rawQuota <= 100
          ? rawQuota : 10
        const day = dateKey(now)
        const progress = await learn_progress.toArray()
        const completedToday = progress.filter((item) => item.firstCompletedAt !== undefined
          && dateKey(item.firstCompletedAt) === day).length
        const allDecks = (await decks.toArray()).filter((item) => item.archivedAt === undefined)
        const selectedDecks = deckId ? allDecks.filter((item) => item.id === deckId) : allDecks
        const completed = new Set(progress.filter((item) => item.firstCompletedAt !== undefined).map((item) => item.entryId))
        const locked = new Set((await learn_sessions.where('status').anyOf('active', 'paused').toArray())
          .flatMap((session) => session.entryIds.slice(session.currentIndex)))
        const activeSession = (await learn_sessions.where('status').anyOf('active', 'paused').toArray())
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        const pendingEntries = (await Promise.all(selectedDecks.map((deck) =>
          entries.where('deckId').equals(deck.id).toArray()))).flat()
        const candidates = pendingEntries.filter((entry) => entry.deletedAt === undefined
          && !completed.has(entry.id) && !locked.has(entry.id))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .slice(0, Math.max(0, Math.min(quota - completedToday, quota)))
        const progressByEntry = new Map(progress.map((item) => [item.entryId, item]))
        const practiceCandidates = pendingEntries
          .filter((entry) => entry.deletedAt === undefined && completed.has(entry.id))
          .sort((a, b) => (progressByEntry.get(a.id)?.lastPracticedAt ?? 0)
            - (progressByEntry.get(b.id)?.lastPracticedAt ?? 0)
            || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .slice(0, 10)
        return { quota, completedToday, candidates, practiceCandidates, decks: allDecks, activeSession, day }
      }),

    startSession: (deckId: string, mode: LearnMode, entryIds: string[], newWords: boolean, now = Date.now()) =>
      database.transaction('rw', [decks, entries, learn_progress, learn_sessions, practice_events, client_outbox, sync_meta, database.preferences], async () => {
        const active = await learn_sessions.where('status').anyOf('active', 'paused').first()
        if (active) return active
        const deck = await decks.get(deckId)
        if (!deck || deck.archivedAt !== undefined) throw new LearnError('Choose an active deck to start learning.')
        const expected = new Set(entryIds)
        if (!expected.size || expected.size !== entryIds.length) throw new LearnError('Choose at least one new word.')
        const progress = new Set((await learn_progress.toArray())
          .filter((item) => item.firstCompletedAt !== undefined).map((item) => item.entryId))
        const locked = new Set((await learn_sessions.where('status').anyOf('active', 'paused').toArray())
          .flatMap((session) => session.entryIds.slice(session.currentIndex)))
        const available = (await entries.where('deckId').equals(deckId).toArray())
          .filter((entry) => expected.has(entry.id) && entry.deletedAt === undefined
            && (newWords ? !progress.has(entry.id) : progress.has(entry.id)) && !locked.has(entry.id))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        if (!available.length) throw new LearnError('There are no available words in this selection.')
        const entryIdsInSession = available.map((entry) => entry.id)
        if (newWords) {
          const daily = await database.preferences.get('daily-new-words')
          const dailyCount = typeof daily?.value === 'number' ? daily.value : 10
          const state = await learn_progress.toArray()
          const completedToday = state.filter((item) => item.firstCompletedAt !== undefined
            && dateKey(item.firstCompletedAt) === dateKey(now)).length
          if (completedToday + entryIdsInSession.length > dailyCount) {
            throw new LearnError('The daily new word limit changed. Review today’s Learn quota before starting again.')
          }
        }
        const session: LearnSessionRecord = {
          sessionId: crypto.randomUUID(), deckId, mode, entryIds: entryIdsInSession, currentIndex: 0,
          startedAt: now, updatedAt: now, status: 'active', dailyKey: dateKey(now),
          firstCompletedEntryIds: [], currentEntryStartedAt: now, currentAttempts: 0, currentAssisted: false,
          ttsVoicesAvailable: undefined,
        }
        await learn_sessions.add(session)
        return session
      }),

    getSession: (sessionId: string) => database.transaction('r', [decks, entries, learn_sessions], async () => {
      const session = await learn_sessions.get(sessionId)
      if (!session) return null
      if (!isOpen(session)) return { session, entry: undefined, invalidReason: undefined }
      const deck = await decks.get(session.deckId)
      const entry = await entries.get(currentId(session) ?? '')
      const invalidReason = !deck ? 'missing' as const
        : deck.archivedAt !== undefined ? 'archived' as const
          : !isUsable(entry, session) ? 'removed' as const : undefined
      return { session, entry: invalidReason ? undefined : entry, invalidReason }
    }),

    setMode: (sessionId: string, mode: LearnMode) => database.transaction('rw', learn_sessions, async () => {
      const session = await learn_sessions.get(sessionId)
      if (!session || session.status === 'completed' || session.status === 'abandoned') return
      const now = Date.now()
      await learn_sessions.put({ ...session, mode, updatedAt: now })
    }),

    setAssisted: (sessionId: string, entryId: string) =>
      database.transaction('rw', [decks, entries, learn_sessions], async () => {
        const session = await learn_sessions.get(sessionId)
        if (!session || session.status !== 'active' || session.mode !== 'dictation'
          || currentId(session) !== entryId || session.currentAssisted) return false
        const deck = await decks.get(session.deckId)
        if (!deck || deck.archivedAt !== undefined || !isUsable(await entries.get(entryId), session)) return false
        await learn_sessions.put({ ...session, currentAssisted: true, updatedAt: Date.now() })
        return true
      }),

    setStatus: (sessionId: string, status: 'active' | 'paused' | 'abandoned' | 'completed') =>
      database.transaction('rw', learn_sessions, async () => {
        const session = await learn_sessions.get(sessionId)
        if (!session || session.status === 'completed' || session.status === 'abandoned') return
        await learn_sessions.put({ ...session, status, updatedAt: Date.now() })
      }),

    continueSession: (sessionId: string, now = Date.now()) =>
      database.transaction('rw', [decks, entries, learn_sessions], async () => {
        const session = await learn_sessions.get(sessionId)
        if (!session || !isOpen(session)) return session
        const updated = await reconcile({ ...session, status: 'active', updatedAt: now }, now)
        await learn_sessions.put(updated)
        return updated
      }),

    advanceInvalid: (sessionId: string, expectedEntryId: string | undefined, now = Date.now()) =>
      database.transaction('rw', [decks, entries, learn_sessions], async () => {
        const session = await learn_sessions.get(sessionId)
        if (!session || !isOpen(session) || currentId(session) !== expectedEntryId) return
        const updated = await reconcile(session, now)
        if (updated !== session) await learn_sessions.put(updated)
      }),

    recordAttempt: (sessionId: string, input: string, correct: boolean, now = Date.now(), expectedEntryId?: string) =>
      database.transaction('rw', [decks, entries, learn_sessions], async () => {
        const session = await learn_sessions.get(sessionId)
        if (!session || session.status !== 'active' || session.currentLastSubmitted === input) return null
        const entryId = currentId(session)
        if (!entryId || (expectedEntryId !== undefined && entryId !== expectedEntryId)) return null
        const deck = await decks.get(session.deckId)
        const entry = await entries.get(entryId)
        if (!deck || deck.archivedAt !== undefined || !isUsable(entry, session)
          || isSpellingCorrect(entry.term, input) !== correct
          || (session.currentLastSubmitted && isSpellingCorrect(entry.term, session.currentLastSubmitted))) return null
        await learn_sessions.put({ ...session, currentAttempts: session.currentAttempts + 1,
          currentFirstTryCorrect: session.currentFirstTryCorrect ?? correct, currentLastSubmitted: input,
          updatedAt: now })
        return { first: session.currentAttempts === 0, attempts: session.currentAttempts + 1, assisted: session.currentAssisted }
      }),

    finishCurrent: (sessionId: string, outcome: 'completed' | 'skipped', now = Date.now(), expectedIndex?: number, expectedEntryId?: string) =>
      database.transaction('rw', [decks, entries, learn_sessions, learn_progress, practice_events,
        client_outbox, sync_meta], async () => {
        const session = await learn_sessions.get(sessionId)
        if (!session || session.status !== 'active' || (expectedIndex !== undefined && session.currentIndex !== expectedIndex)) return null
        const entryId = currentId(session)
        if (expectedEntryId !== undefined && entryId !== expectedEntryId) return null
        const entry = entryId ? await entries.get(entryId) : undefined
        const deck = await decks.get(session.deckId)
        if (!isUsable(entry, session) || !deck || deck.archivedAt !== undefined) {
          const updated = await reconcile(session, now)
          if (updated !== session) await learn_sessions.put(updated)
          return null
        }
        if (outcome === 'completed'
          && (!session.currentLastSubmitted || !isSpellingCorrect(entry.term, session.currentLastSubmitted))) {
          return null
        }
        const event: PracticeEvent = {
          id: crypto.randomUUID(), deckId: session.deckId, entryId: entry.id, sessionId: session.sessionId,
          mode: session.mode, outcome, attempts: session.currentAttempts,
          firstTryCorrect: session.currentFirstTryCorrect ?? false, assisted: session.currentAssisted,
          startedAt: session.currentEntryStartedAt, completedAt: now,
        }
        const progress = await learn_progress.get(entry.id)
        const firstCompletion = outcome === 'completed' && progress?.firstCompletedAt === undefined
        const changedProgress: LearnProgressRecord | undefined = outcome === 'completed' ? {
          entryId: entry.id, firstCompletedAt: progress?.firstCompletedAt ?? now,
          lastPracticedAt: now, completedCount: (progress?.completedCount ?? 0) + 1,
        } : undefined
        const updated: LearnSessionRecord = {
          ...resetWord(session, session.currentIndex + 1, now),
          firstCompletedEntryIds: firstCompletion
            ? [...session.firstCompletedEntryIds, entry.id] : session.firstCompletedEntryIds,
          dailyKey: dateKey(now),
        }
        await practice_events.add(event)
        if (changedProgress) await learn_progress.put(changedProgress)
        await learn_sessions.put(updated)
        await appendChanges([{
          opId: event.id, schemaVersion: 1, entityId: entry.id, kind: 'practice.create',
          payload: event, baseRevision: 0,
        }], now)
        return { event, firstCompletion, session: updated }
      }),

    result: (sessionId: string) => database.transaction('r', [practice_events, learn_sessions], async () => {
      const session = await learn_sessions.get(sessionId)
      if (!session) return null
      const events = await practice_events.where('sessionId').equals(sessionId).toArray()
      return {
        session, events,
        completed: events.filter(({ outcome }) => outcome === 'completed').length,
        skipped: events.filter(({ outcome }) => outcome === 'skipped').length,
        firstCompleted: session.firstCompletedEntryIds.length,
        firstTryCorrect: events.filter(({ outcome, firstTryCorrect, assisted }) => outcome === 'completed' && firstTryCorrect && !assisted).length,
        attempts: events.reduce((sum, { attempts }) => sum + attempts, 0),
        assisted: events.filter(({ assisted }) => assisted).length,
      }
    }),
  }
}
