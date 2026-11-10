import { randomUUID } from 'node:crypto'
import { dateKey, isSpellingCorrect, type LearnMode, type LearnSession, type PracticeEvent } from '../../shared/domain/learning.ts'
import { checkRevision, StudyError, type StudyStore, type Versioned } from './store.ts'

const currentId = (session: LearnSession) => session.entryIds[session.currentIndex]
const open = (session: LearnSession) => session.status === 'active' || session.status === 'paused'

function resetWord(session: Versioned<LearnSession>, index: number, now: number): Versioned<LearnSession> {
  const exhausted = index >= session.entryIds.length
  return {
    ...session, currentIndex: exhausted ? Math.max(0, session.entryIds.length - 1) : index,
    status: exhausted ? 'completed' : session.status,
    updatedAt: now, currentEntryStartedAt: now, currentAttempts: 0,
    currentFirstTryCorrect: undefined, currentAssisted: false, currentLastSubmitted: undefined,
  }
}

export function createLearnService(store: StudyStore) {
  function dayState(now: number) {
    const { dailyNewWords: quota, timezone } = store.settings()
    const day = dateKey(now, timezone)
    const progress = store.progress()
    const completedToday = progress.filter((item) => item.firstCompletedAt !== undefined
      && dateKey(item.firstCompletedAt, timezone) === day).length
    return { day, quota, completedToday, progress }
  }

  function usableEntry(session: LearnSession, id = currentId(session)) {
    const entry = id && store.entry(id)
    return entry && entry.deckId === session.deckId && entry.deletedAt === undefined ? entry : undefined
  }

  function reconcile(session: Versioned<LearnSession>, now: number) {
    const deck = store.deck(session.deckId)
    if (!deck) return { ...session, status: 'abandoned' as const, updatedAt: now }
    if (deck.archivedAt !== undefined) return session.status === 'paused' ? session
      : { ...session, status: 'paused' as const, updatedAt: now }
    if (usableEntry(session)) return session
    const next = session.entryIds.findIndex((id, index) => index >= session.currentIndex && usableEntry(session, id))
    const entryIds = session.entryIds.slice(0, session.currentIndex).concat(next < 0 ? [] : session.entryIds.slice(next))
    return resetWord({ ...session, entryIds }, session.currentIndex, now)
  }

  function requireSession(id: string, revision: number, active = false) {
    const session = store.learn(id)
    checkRevision(session, revision)
    if (!session || !open(session) || (active && session.status !== 'active')) {
      throw new StudyError('This Learn session is no longer active.', 409)
    }
    return session
  }

  function requireWord(session: LearnSession, id: string) {
    const entry = usableEntry(session)
    const deck = store.deck(session.deckId)
    if (!deck || deck.archivedAt !== undefined || !entry || entry.id !== id) {
      throw new StudyError('The current word changed. Reload the session.', 409)
    }
    return entry
  }

  const oldest = (a: { createdAt: number; id: string }, b: typeof a) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)

  return {
    getDailyState(deckId: string | undefined, now: number) {
      const { quota, completedToday, day, progress } = dayState(now)
      const decks = store.decks().filter((deck) => deck.archivedAt === undefined)
      const deckIds = new Set(decks.filter((deck) => !deckId || deckId === deck.id).map(({ id }) => id))
      const learned = new Map(progress.filter((item) => item.firstCompletedAt !== undefined).map((item) => [item.entryId, item]))
      const activeSession = store.openLearn()
      const locked = new Set(activeSession?.entryIds.slice(activeSession.currentIndex))
      const entries = store.entries(deckId).filter((entry) => entry.deletedAt === undefined && deckIds.has(entry.deckId))
      const candidates = entries.filter((entry) => !learned.has(entry.id) && !locked.has(entry.id))
        .sort(oldest).slice(0, Math.max(0, quota - completedToday))
      const practiceCandidates = entries.filter((entry) => learned.has(entry.id))
        .sort((a, b) => learned.get(a.id)!.lastPracticedAt - learned.get(b.id)!.lastPracticedAt || oldest(a, b)).slice(0, 10)
      return { quota, completedToday, day, decks, activeSession, candidates, practiceCandidates }
    },
    startSession(deckId: string, mode: LearnMode, entryIds: string[], newWords: boolean, now: number) {
      const active = store.openLearn()
      if (active) return active
      const deck = store.deck(deckId)
      if (!deck || deck.archivedAt !== undefined) throw new StudyError('Choose an active deck to start learning.')
      const expected = new Set(entryIds)
      const { quota, completedToday, day, progress } = dayState(now)
      const completed = new Set(progress.filter((item) => item.firstCompletedAt !== undefined).map(({ entryId }) => entryId))
      const available = store.entries(deckId).filter((entry) => expected.has(entry.id) && entry.deletedAt === undefined
        && completed.has(entry.id) !== newWords).sort(oldest)
      if (!available.length || available.length !== expected.size || expected.size !== entryIds.length) {
        throw new StudyError('The selected words changed. Reload today’s Learn list.', 409)
      }
      if (newWords && completedToday + available.length > quota) throw new StudyError('The daily new word limit changed.', 409)
      return store.saveLearn({
        sessionId: randomUUID(), deckId, mode, entryIds: available.map(({ id }) => id), currentIndex: 0,
        startedAt: now, updatedAt: now, status: 'active', dailyKey: day,
        firstCompletedEntryIds: [], currentEntryStartedAt: now, currentAttempts: 0, currentAssisted: false,
      })
    },
    getSession(id: string) {
      const session = store.learn(id)
      if (!session) return null
      if (!open(session)) return { session, entry: undefined, invalidReason: undefined }
      const deck = store.deck(session.deckId)
      const entry = usableEntry(session)
      const invalidReason = !deck ? 'missing' as const : deck.archivedAt !== undefined ? 'archived' as const
        : !entry ? 'removed' as const : undefined
      return { session, entry: invalidReason ? undefined : entry, invalidReason }
    },
    setMode(id: string, mode: LearnMode, revision: number, now: number) {
      store.saveLearn({ ...requireSession(id, revision), mode, updatedAt: now })
    },
    setAssisted(id: string, entryId: string, revision: number, now: number) {
      const session = requireSession(id, revision, true)
      requireWord(session, entryId)
      if (session.mode !== 'dictation' || session.currentAssisted) return false
      store.saveLearn({ ...session, currentAssisted: true, updatedAt: now })
      return true
    },
    setStatus(id: string, status: 'paused' | 'abandoned', revision: number, now: number) {
      store.saveLearn({ ...requireSession(id, revision), status, updatedAt: now })
    },
    continueSession(id: string, revision: number, now: number) {
      const session = requireSession(id, revision)
      return store.saveLearn(reconcile({ ...session, status: 'active', updatedAt: now }, now))
    },
    advanceInvalid(id: string, revision: number, now: number) {
      const session = requireSession(id, revision)
      const updated = reconcile(session, now)
      if (updated !== session) store.saveLearn(updated)
    },
    recordAttempt(id: string, entryId: string, input: string, revision: number, now: number) {
      const session = requireSession(id, revision, true)
      const entry = requireWord(session, entryId)
      if (session.currentLastSubmitted === input) return null
      if (session.currentLastSubmitted && isSpellingCorrect(entry.term, session.currentLastSubmitted)) {
        throw new StudyError('This word has already been answered correctly.', 409)
      }
      const correct = isSpellingCorrect(entry.term, input)
      const updated = store.saveLearn({ ...session, currentAttempts: session.currentAttempts + 1,
        currentFirstTryCorrect: session.currentFirstTryCorrect ?? correct, currentLastSubmitted: input, updatedAt: now })
      return { first: session.currentAttempts === 0, attempts: updated.currentAttempts, assisted: session.currentAssisted, correct }
    },
    finishCurrent(id: string, entryId: string, outcome: 'completed' | 'skipped', revision: number, now: number) {
      const session = requireSession(id, revision, true)
      const entry = requireWord(session, entryId)
      const correct = !!session.currentLastSubmitted && isSpellingCorrect(entry.term, session.currentLastSubmitted)
      if ((outcome === 'completed') !== correct) throw new StudyError('Submit the current answer before finishing this word.', 409)
      const progress = store.entryProgress(entryId)
      const firstCompletion = outcome === 'completed' && progress?.firstCompletedAt === undefined
      const { day, quota, completedToday } = dayState(now)
      if (firstCompletion && completedToday >= quota) throw new StudyError('The daily new word limit has been reached.', 409)
      const event: PracticeEvent = {
        id: randomUUID(), deckId: session.deckId, entryId, sessionId: id, mode: session.mode, outcome,
        attempts: session.currentAttempts, firstTryCorrect: session.currentFirstTryCorrect ?? false,
        assisted: session.currentAssisted, startedAt: session.currentEntryStartedAt, completedAt: now,
      }
      store.addPractice(event)
      if (outcome === 'completed') store.saveProgress({
        entryId, firstCompletedAt: progress?.firstCompletedAt ?? now,
        lastPracticedAt: Math.max(progress?.lastPracticedAt ?? now, now), completedCount: (progress?.completedCount ?? 0) + 1,
      })
      const updated = store.saveLearn({
        ...resetWord(session, session.currentIndex + 1, now), dailyKey: day,
        firstCompletedEntryIds: firstCompletion ? [...session.firstCompletedEntryIds, entryId] : session.firstCompletedEntryIds,
      })
      return { event, firstCompletion, session: updated }
    },
    result(id: string, offset: number, limit: number) {
      const session = store.learn(id)
      if (!session) return null
      const events = store.all<PracticeEvent>(
        "SELECT body FROM practice_events WHERE json_extract(body, '$.sessionId')=? ORDER BY json_extract(body, '$.completedAt'), id", id)
      return {
        session, events: events.slice(offset, offset + limit),
        completed: events.filter(({ outcome }) => outcome === 'completed').length,
        skipped: events.filter(({ outcome }) => outcome === 'skipped').length,
        firstCompleted: session.firstCompletedEntryIds.length,
        firstTryCorrect: events.filter(({ outcome, firstTryCorrect, assisted }) => outcome === 'completed' && firstTryCorrect && !assisted).length,
        attempts: events.reduce((sum, { attempts }) => sum + attempts, 0),
        assisted: events.filter(({ assisted }) => assisted).length,
      }
    },
  }
}
