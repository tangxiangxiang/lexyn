import { randomUUID } from 'node:crypto'
import { compareSpelling, dateKey, hasCorrectSpelling, isSpellingCorrect, normalizeSpelling, practiceRound, type LearnMode, type LearnSession, type PracticeEvent } from '../../shared/domain/learning.ts'
import { checkRevision, StudyError, type StudyStore, type Versioned } from './store.ts'
import type { Entry } from '../../shared/domain/library.ts'
import { defaultSpelling, spellingErrors, spellingKeyboard, type PracticeSource, type SpellingHint } from '../../shared/domain/spelling.ts'
import { spellingSyllables } from '../../shared/domain/spelling-syllables.ts'
import { isStudyDay } from '../../shared/domain/study-plan.ts'

const currentId = (session: LearnSession) => session.entryIds[session.currentIndex]
const open = (session: LearnSession) => session.status === 'active' || session.status === 'paused'

function resetWord(session: Versioned<LearnSession>, index: number, now: number): Versioned<LearnSession> {
  const exhausted = index >= session.entryIds.length
  return {
    ...session, currentIndex: exhausted ? Math.max(0, session.entryIds.length - 1) : index,
    status: exhausted ? 'completed' : session.status,
    updatedAt: now, currentEntryStartedAt: now, currentAttempts: 0,
    currentFirstTryCorrect: undefined, currentAssisted: false, currentLastSubmitted: undefined,
    currentHints: [], currentKeyboard: undefined, currentCorrectSpelling: undefined,
  }
}

export function createLearnService(store: StudyStore) {
  function dayState(now: number) {
    const { dailyNewWords, studyWeekdays, timezone } = store.settings()
    const day = dateKey(now, timezone)
    const quota = isStudyDay(day, studyWeekdays) ? dailyNewWords : 0
    const progress = store.progress()
    const completedToday = progress.filter((item) => item.firstCompletedAt !== undefined
      && dateKey(item.firstCompletedAt, timezone) === day).length
    return { day, quota, dailyNewWords, completedToday, progress }
  }

  function usableEntry(session: LearnSession, id = currentId(session)) {
    const entry = id && store.entry(id)
    return entry && entry.deckId === session.deckId && entry.deletedAt === undefined ? entry : undefined
  }

  function withDefaultHints<T extends LearnSession>(session: T): T {
    const entry = usableEntry(session)
    if (session.status !== 'active' || session.mode !== 'copy' || !session.spelling?.syllables
      || !entry || !spellingSyllables(entry.term)) return session
    return { ...session, currentHints: [...new Set<SpellingHint>([...(session.currentHints ?? []), 'syllables'])], currentAssisted: true }
  }

  function visibleAnswer(session: LearnSession) {
    return session.mode === 'copy' || (session.currentHints
      ? session.currentHints.includes('reveal') || session.currentHints.includes('syllables')
      : session.currentAssisted)
  }

  function keyboardLayout(session: LearnSession, entry: Entry) {
    const requested = session.mode === 'copy' ? session.currentKeyboard ?? session.spelling?.keyboard
      : session.currentHints?.includes('keyboard') ? 'simplified' : 'full'
    return spellingKeyboard(entry.term, requested ?? 'full', visibleAnswer(session) || requested === 'simplified')
  }

  function publicSession<T extends LearnSession>(session: T): T {
    if (visibleAnswer(session)) return session
    return { ...session, currentCorrectSpelling: undefined,
      currentLastSubmitted: session.spelling?.strict === false ? session.currentLastSubmitted : undefined }
  }

  function reconcile(session: Versioned<LearnSession>, now: number) {
    const deck = store.deck(session.deckId)
    if (!deck) return { ...session, status: 'abandoned' as const, updatedAt: now }
    if (deck.archivedAt !== undefined) return session.status === 'paused' ? session
      : { ...session, status: 'paused' as const, updatedAt: now }
    if (usableEntry(session)) return session
    const next = session.entryIds.findIndex((id, index) => index >= session.currentIndex && usableEntry(session, id))
    const entryIds = session.entryIds.slice(0, session.currentIndex).concat(next < 0 ? [] : session.entryIds.slice(next))
    return withDefaultHints(resetWord({ ...session, entryIds }, session.currentIndex, now))
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

  function entriesInScope(deckId?: string, listId?: string) {
    if (!listId) return store.entries(deckId).sort(oldest)
    if (!deckId || !store.lists.get(deckId, listId)) throw new StudyError('List not found in this deck.', 404)
    return store.lists.entries(deckId, listId)
  }

  return {
    getDailyState(deckId: string | undefined, now: number, listId?: string) {
      const { quota, dailyNewWords, completedToday, day, progress } = dayState(now)
      const decks = store.decks().filter((deck) => deck.archivedAt === undefined)
      const deckIds = new Set(decks.filter((deck) => !deckId || deckId === deck.id).map(({ id }) => id))
      const learned = new Map(progress.filter((item) => item.firstCompletedAt !== undefined).map((item) => [item.entryId, item]))
      const activeSession = store.openLearn()
      const locked = new Set(activeSession?.entryIds.slice(activeSession.currentIndex))
      const entries = entriesInScope(deckId, listId).filter((entry) => entry.deletedAt === undefined && deckIds.has(entry.deckId))
      const candidates = entries.filter((entry) => !learned.has(entry.id) && !locked.has(entry.id))
        .slice(0, Math.max(0, quota - completedToday))
      const practiceCandidates = entries.filter((entry) => learned.has(entry.id))
        .sort((a, b) => learned.get(a.id)!.lastPracticedAt - learned.get(b.id)!.lastPracticedAt || oldest(a, b)).slice(0, 10)
      const lists = listId && deckId ? store.lists.summaries(deckId) : []
      const list = lists.find(({ id }) => id === listId)
      const nextList = list && lists.find(({ order, count }) => order > list.order && count > 0)
      return { quota, dailyNewWords, completedToday, day, decks, activeSession: activeSession && publicSession(activeSession), candidates, practiceCandidates, list, nextList }
    },
    freeState() {
      const active = store.openLearn('free')
      return active && publicSession(active)
    },
    startFree(deckId: string, mode: LearnMode, now: number, listId?: string) {
      const active = store.openLearn('free')
      if (active) {
        if (active.deckId !== deckId || active.listId !== listId) throw new StudyError('Another free practice session is open.', 409)
        return publicSession(active)
      }
      const deck = store.deck(deckId)
      if (!deck || deck.archivedAt !== undefined) throw new StudyError('Choose an active deck to start learning.')
      const entryIds = entriesInScope(deckId, listId).filter((entry) => entry.deletedAt === undefined)
        .slice(0, 100).map(({ id }) => id)
      if (!entryIds.length) throw new StudyError('There are no words to practice.')
      return publicSession(store.saveLearn(withDefaultHints({
        source: 'free', spelling: store.spellingSettings(), currentHints: [],
        sessionId: randomUUID(), deckId, listId, mode, entryIds, currentIndex: 0,
        startedAt: now, updatedAt: now, status: 'active', dailyKey: dateKey(now, store.settings().timezone),
        firstCompletedEntryIds: [], currentEntryStartedAt: now, currentAttempts: 0, currentAssisted: false,
      })))
    },
    startSession(deckId: string, mode: LearnMode, entryIds: string[], newWords: boolean, now: number, listId?: string) {
      const active = store.openLearn()
      if (active) {
        if (listId && (active.listId !== listId || active.deckId !== deckId)) {
          throw new StudyError('Another Learn session is open. Continue or end it before starting this list.', 409)
        }
        return publicSession(active)
      }
      const deck = store.deck(deckId)
      if (!deck || deck.archivedAt !== undefined) throw new StudyError('Choose an active deck to start learning.')
      const expected = new Set(entryIds)
      const { quota, completedToday, day, progress } = dayState(now)
      const completed = new Set(progress.filter((item) => item.firstCompletedAt !== undefined).map(({ entryId }) => entryId))
      const available = entriesInScope(deckId, listId).filter((entry) => expected.has(entry.id) && entry.deletedAt === undefined
        && completed.has(entry.id) !== newWords)
      if (!available.length || available.length !== expected.size || expected.size !== entryIds.length) {
        throw new StudyError('The selected words changed. Reload today’s Learn list.', 409)
      }
      if (newWords && completedToday + available.length > quota) throw new StudyError('The daily new word limit changed.', 409)
      return publicSession(store.saveLearn(withDefaultHints({
        spelling: store.spellingSettings(), currentHints: [],
        sessionId: randomUUID(), deckId, listId, mode, entryIds: available.map(({ id }) => id), currentIndex: 0,
        startedAt: now, updatedAt: now, status: 'active', dailyKey: day,
        firstCompletedEntryIds: [], currentEntryStartedAt: now, currentAttempts: 0, currentAssisted: false,
      })))
    },
    getSession(id: string) {
      const session = store.learn(id)
      if (!session) return null
      if (!open(session)) return { session: publicSession(session), entry: undefined, invalidReason: undefined }
      const deck = store.deck(session.deckId)
      const entry = usableEntry(session)
      const invalidReason = !deck ? 'missing' as const : deck.archivedAt !== undefined ? 'archived' as const
        : !entry ? 'removed' as const : undefined
      const word = invalidReason ? undefined : entry
      const answerVisible = visibleAnswer(session)
      const revealed = word && !answerVisible ? {
        id: word.id, revision: word.revision, term: '',
        meaning: normalizeSpelling(word.meaning).includes(normalizeSpelling(word.term)) ? '' : word.meaning,
        phonetic: undefined, phonetics: undefined, dictionaryMeaning: undefined, example: undefined,
      } : word
      const layout = word ? keyboardLayout(session, word) : undefined
      // An assisted keyboard sends keys only, not the target or its order.
      const keyboard = layout?.layout === 'simplified' && !answerVisible
        ? { ...layout, symbols: [...layout.symbols].sort() } : layout
      return {
        session: publicSession(session), entry: revealed, invalidReason, answerVisible, keyboard,
        correct: !!word && hasCorrectSpelling(session, word.term, word.termChangedAt),
        syllables: word && session.currentHints?.includes('syllables') ? spellingSyllables(word.term) : undefined,
      }
    },
    setMode(id: string, mode: LearnMode, revision: number, now: number) {
      const session = requireSession(id, revision)
      if (session.mode === mode) return
      const currentHints = session.currentHints ?? (session.currentAssisted ? ['reveal' as const] : [])
      store.saveLearn(withDefaultHints({ ...session, mode, currentHints: currentHints.filter((hint) => hint === 'reveal'),
        currentKeyboard: undefined, currentAssisted: true, currentLastSubmitted: undefined, updatedAt: now }))
    },
    setAssisted(id: string, entryId: string, revision: number, now: number, hint: SpellingHint = 'reveal', enabled = true) {
      const session = requireSession(id, revision, true)
      const entry = requireWord(session, entryId)
      if (hint === 'syllables' && !spellingSyllables(entry.term)) return false
      if (hint === 'keyboard' && spellingKeyboard(entry.term, 'simplified', true).layout !== 'simplified') return false
      const hints = new Set<SpellingHint>(session.currentHints ?? (session.currentAssisted ? ['reveal'] : []))
      if (hint !== 'keyboard' && hints.has(hint) === enabled) return false
      if (enabled) hints.add(hint)
      else hints.delete(hint)
      const assisted = session.currentAssisted || (enabled && (session.mode === 'dictation' || hint === 'syllables'))
      store.saveLearn({ ...session, currentHints: [...hints], currentAssisted: assisted, updatedAt: now,
        currentKeyboard: hint === 'keyboard' ? enabled ? 'simplified' : 'full' : session.currentKeyboard })
      return true
    },
    setStatus(id: string, status: 'paused' | 'abandoned', revision: number, now: number) {
      const session = requireSession(id, revision)
      store.saveLearn({ ...session, status, updatedAt: now,
        currentLastSubmitted: status === 'abandoned' ? undefined : session.currentLastSubmitted })
    },
    continueSession(id: string, revision: number, now: number) {
      const session = requireSession(id, revision)
      return publicSession(store.saveLearn(reconcile({ ...session, status: 'active', updatedAt: now }, now)))
    },
    advanceInvalid(id: string, revision: number, now: number) {
      const session = requireSession(id, revision)
      const updated = reconcile(session, now)
      if (updated !== session) store.saveLearn(updated)
    },
    recordAttempt(id: string, entryId: string, input: string, revision: number, now: number,
      partial = false) {
      const session = requireSession(id, revision, true)
      const entry = requireWord(session, entryId)
      if (hasCorrectSpelling(session, entry.term, entry.termChangedAt)) {
        throw new StudyError('This word has already been answered correctly.', 409)
      }
      if (partial && (session.mode !== 'copy' || !(session.spelling ?? defaultSpelling).strict)) {
        throw new StudyError('Only strict copy accepts partial spelling attempts.')
      }
      const correct = isSpellingCorrect(entry.term, input)
      const errors = correct ? [] : spellingErrors(entry.term, input, partial)
      if (partial && !errors.length) throw new StudyError('Submit a full answer or an incorrect prefix.')
      const layout = keyboardLayout(session, entry).layout
      const attempts = session.currentAttempts + 1
      const round = practiceRound(session)
      store.addSpellingAttempt({
        id: randomUUID(), entryId, sessionId: id, round, attempt: attempts, spelling: normalizeSpelling(entry.term),
        termChangedAt: entry.termChangedAt, time: now, source: session.source ?? 'learn', mode: session.mode,
        keyboard: layout, assisted: session.currentAssisted, correct,
        errors,
      })
      store.saveLearn({ ...session, currentAttempts: attempts,
        currentFirstTryCorrect: session.currentFirstTryCorrect ?? correct,
        currentLastSubmitted: !correct && session.mode === 'dictation' && session.spelling?.strict === false ? input : undefined,
        currentCorrectSpelling: correct ? { term: normalizeSpelling(entry.term), changedAt: entry.termChangedAt } : undefined, updatedAt: now })
      return { first: attempts === 1, attempts, assisted: session.currentAssisted, correct,
        feedback: correct || partial ? [] : compareSpelling(normalizeSpelling(entry.term), normalizeSpelling(input)) }
    },
    finishCurrent(id: string, entryId: string, outcome: 'completed' | 'skipped', revision: number, now: number) {
      const session = requireSession(id, revision, true)
      const entry = requireWord(session, entryId)
      const correct = hasCorrectSpelling(session, entry.term, entry.termChangedAt)
      if ((outcome === 'completed') !== correct) throw new StudyError('Submit the current answer before finishing this word.', 409)
      const formal = session.source !== 'free'
      const progress = formal ? store.entryProgress(entryId) : undefined
      const firstCompletion = formal && outcome === 'completed' && progress?.firstCompletedAt === undefined
      const today = formal ? dayState(now) : undefined
      if (firstCompletion && today && today.completedToday >= today.quota) {
        throw new StudyError('The daily new word limit has been reached.', 409)
      }
      const round = practiceRound(session)
      const event: PracticeEvent = {
        id: randomUUID(), deckId: session.deckId, entryId, sessionId: id, mode: session.mode, outcome,
        source: session.source ?? 'learn', round,
        attempts: session.currentAttempts, firstTryCorrect: session.currentFirstTryCorrect ?? false,
        assisted: session.currentAssisted, startedAt: session.currentEntryStartedAt, completedAt: now,
      }
      store.addPractice(event)
      if (formal && outcome === 'completed') store.saveProgress({
        entryId, firstCompletedAt: progress?.firstCompletedAt ?? now,
        lastPracticedAt: Math.max(progress?.lastPracticedAt ?? now, now), completedCount: (progress?.completedCount ?? 0) + 1,
      })
      const retry = round < (session.spelling?.retryLimit ?? 0)
        && session.currentAttempts > 0 && !session.currentFirstTryCorrect
      const queued = retry ? { ...session, entryIds: [...session.entryIds, entryId] } : session
      const updated = store.saveLearn({
        ...withDefaultHints(resetWord(queued, session.currentIndex + 1, now)), dailyKey: today?.day ?? session.dailyKey,
        firstCompletedEntryIds: firstCompletion ? [...session.firstCompletedEntryIds, entryId] : session.firstCompletedEntryIds,
      })
      return { event, firstCompletion, session: publicSession(updated) }
    },
    result(id: string, offset: number, limit: number) {
      const session = store.learn(id)
      if (!session) return null
      const events = store.all<PracticeEvent>(
        "SELECT body FROM practice_events WHERE json_extract(body, '$.sessionId')=? ORDER BY json_extract(body, '$.completedAt'), id", id)
      return {
        session: publicSession(session), events: events.slice(offset, offset + limit),
        completed: events.filter(({ outcome }) => outcome === 'completed').length,
        skipped: events.filter(({ outcome }) => outcome === 'skipped').length,
        firstCompleted: session.firstCompletedEntryIds.length,
        firstTryCorrect: events.filter(({ outcome, firstTryCorrect, assisted, round }) =>
          outcome === 'completed' && firstTryCorrect && !assisted && !round).length,
        retried: events.filter(({ round, outcome }) => round && outcome === 'completed').length,
        corrected: events.filter(({ round, outcome, firstTryCorrect, assisted }) =>
          !round && outcome === 'completed' && !firstTryCorrect && !assisted).length,
        unfinished: session.status === 'abandoned' ? session.entryIds.length - session.currentIndex : 0,
        difficult: [...new Set(events.filter((event) => (event.round ?? 0) === (session.spelling?.retryLimit ?? 0)
          && event.attempts > 0 && !event.firstTryCorrect).map(({ entryId }) => entryId))]
          .map((entryId) => store.entry(entryId)?.term).filter((term): term is string => !!term),
        attempts: events.reduce((sum, { attempts }) => sum + attempts, 0),
        assisted: events.filter(({ assisted }) => assisted).length,
      }
    },
  }
}
