import { randomUUID } from 'node:crypto'
import { REVIEW_DIRECTION, recallPrompt, wordReviewCardId, type ReviewEvent, type ReviewRating, type ReviewSession } from '../../shared/domain/review.ts'
import { FSRS_MODEL, restoreCard, schedulerConfigSnapshot, schedulerGrades, serializeCard, serializeRevlog, type ReviewScheduler } from '../../shared/srs/scheduler.ts'
import type { WordProgress } from '../../shared/domain/word.ts'
import type { Entry } from '../../shared/domain/library.ts'
import { dayBounds, reviewDayBounds } from './calendar.ts'
import { checkRevision, StudyError, type StudyStore, type Versioned } from './store.ts'

export function createReviewService(store: StudyStore, engine: ReviewScheduler) {
  const config = schedulerConfigSnapshot(engine)

  const entryOrder = (a: Entry, b: Entry) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)

  function activeMembers() {
    const decks = store.decks().filter((deck) => deck.archivedAt === undefined)
    const active = new Set(decks.map(({ id }) => id))
    const groups = new Map<string, Entry[]>()
    for (const entry of store.entries().sort(entryOrder)) {
      if (entry.deletedAt !== undefined || !active.has(entry.deckId)) continue
      const group = groups.get(entry.wordId!)
      if (group) group.push(entry)
      else groups.set(entry.wordId!, [entry])
    }
    return { decks, groups }
  }

  function localPrompt(entry: Entry) {
    return recallPrompt(entry.meaning, entry.term)
      ?? recallPrompt(entry.dictionaryReference?.translation ?? '', entry.term)
  }

  function withPrompt(entry: Entry, members: Entry[]) {
    const local = localPrompt(entry)
    if (local) return { entry, prompt: local }
    for (const other of members) {
      if (other.id === entry.id) continue
      const prompt = localPrompt(other)
      if (prompt) return { entry, prompt }
    }
  }

  function listMembership() {
    const rows = store.db.prepare('SELECT entry_id AS entryId, list_id AS listId FROM deck_list_members')
      .all() as { entryId: string; listId: string }[]
    return new Map(rows.map(({ entryId, listId }) => [entryId, listId]))
  }

  function queue(deckId: string | undefined, now: number, listId?: string) {
    const { decks, groups } = activeMembers()
    const learned = new Map(store.progress().map((value) => [value.wordId, value]))
    const cards = new Map(store.activeCards().map((card) => [card.wordId, card]))
    const listByEntry = listMembership()
    const listStats = new Map<string, { due: number; firstRecall: number; nextDueAt?: number }>()
    const deckStats = new Map<string, { due: number; nextDueAt?: number }>()
    const items: { entryId: string; wordId: string; cardId: string; dueAt: number; priority: number }[] = []
    const progress: WordProgress[] = []
    let due = 0
    let firstRecall = 0
    let nextDueAt: number | undefined
    for (const [wordId, members] of groups) {
      const learnedWord = learned.get(wordId)
      if (!learnedWord) continue
      const scope = members.filter((entry) => (!deckId || entry.deckId === deckId) && (!listId || listByEntry.get(entry.id) === listId))
      if (!scope.length) continue
      progress.push(learnedWord)
      const entry = scope.find(localPrompt) ?? scope[0]
      if (!withPrompt(entry, members)) continue
      const card = cards.get(wordId)
      const dueAt = card?.dueAt ?? 0
      if (card) {
        for (const id of new Set(scope.map((member) => member.deckId))) {
          const stats = deckStats.get(id) ?? { due: 0 }
          if (dueAt <= now) stats.due++
          else stats.nextDueAt = Math.min(stats.nextDueAt ?? dueAt, dueAt)
          deckStats.set(id, stats)
        }
      }
      for (const id of new Set(scope.map((member) => listByEntry.get(member.id)))) {
        if (!id) continue
        const stats = listStats.get(id) ?? { due: 0, firstRecall: 0 }
        if (!card) stats.firstRecall++
        else if (dueAt <= now) stats.due++
        else stats.nextDueAt = Math.min(stats.nextDueAt ?? dueAt, dueAt)
        listStats.set(id, stats)
      }
      if (!card) firstRecall++
      else if (dueAt <= now) due++
      else {
        nextDueAt = Math.min(nextDueAt ?? dueAt, dueAt)
        continue
      }
      items.push({ entryId: entry.id, wordId, cardId: card?.id ?? wordReviewCardId(wordId), dueAt,
        priority: !card ? 2 : card.scheduleStatus === 'learning' ? 0 : 1 })
    }
    items.sort((a, b) => a.priority - b.priority || a.dueAt - b.dueAt || a.entryId.localeCompare(b.entryId))
    return { decks, items, due, firstRecall, nextDueAt, progress: deckId || listId ? progress : [...learned.values()],
      deckStats, listStats: [...listStats].map(([id, stats]) => ({ listId: id, ...stats })) }
  }

  function wordAt(session: ReviewSession, index: number) {
    const entryId = session.entryIds[index]
    return session.wordIds ? session.wordIds[index] ?? undefined : entryId ? store.entry(entryId)?.wordId : undefined
  }

  function target(session: ReviewSession, index: number, now: number) {
    const wordId = wordAt(session, index)
    if (!wordId || !store.wordProgress(wordId)) return
    const card = store.activeCard(wordId)
    if (card && card.dueAt > now) return
    const members = store.entriesForWord(wordId).filter((entry) => store.deck(entry.deckId)?.archivedAt === undefined).sort(entryOrder)
    const scope = members.filter((entry) => (!session.deckId || entry.deckId === session.deckId)
      && (!session.listId || store.lists.memberList(entry.id) === session.listId))
    const entry = scope.find(({ id }) => id === session.entryIds[index]) ?? scope.find(localPrompt) ?? scope[0]
    const word = entry && withPrompt(entry, members)
    return word && { ...word, card, wordId, cardId: card?.id ?? wordReviewCardId(wordId) }
  }

  function move(session: Versioned<ReviewSession>, index: number, now: number): Versioned<ReviewSession> {
    const word = target(session, index, now)
    return { ...session, currentIndex: index, updatedAt: now, currentCardId: word?.cardId,
      currentRevealed: false, revealedEntryRevision: undefined, revealedEntryId: undefined,
      status: index < session.entryIds.length ? session.status : 'completed' }
  }

  function reconcile(session: Versioned<ReviewSession>, now: number) {
    const completed = new Set(session.entryIds.slice(0, session.currentIndex).map((_, index) => wordAt(session, index)))
    let index = session.currentIndex
    while (index < session.entryIds.length && (completed.has(wordAt(session, index)) || !target(session, index, now))) index++
    const current = target(session, index, now)
    if (index !== session.currentIndex || current?.cardId !== session.currentCardId) return move(session, index, now)
    if (session.currentRevealed && current && (session.revealedEntryId ?? session.entryIds[index]) !== current.entry.id) {
      return move(session, index, now)
    }
    return session
  }

  function requireSession(id: string, revision: number) {
    const session = store.review(id)
    checkRevision(session, revision)
    if (!session || (session.status !== 'active' && session.status !== 'paused')) {
      throw new StudyError('This Review session is no longer active.', 409)
    }
    return session
  }

  function currentTarget(session: ReviewSession, now: number) {
    const current = target(session, session.currentIndex, now)
    if (current && !session.wordIds?.slice(0, session.currentIndex).includes(current.wordId)) return current
  }

  function requireTarget(session: ReviewSession, cardId: string, now: number) {
    const word = currentTarget(session, now)
    if (session.status !== 'active' || session.currentCardId !== cardId || word?.cardId !== cardId) {
      throw new StudyError('The current card changed. Reload the Review session.', 409)
    }
    return word
  }

  function snapshot(session: Versioned<ReviewSession> | undefined, now: number) {
    if (!session) return null
    const selected = session.status === 'active' ? currentTarget(session, now) : undefined
    const word = selected?.cardId === session.currentCardId ? selected : undefined
    const revealed = !!word && session.currentRevealed && session.revealedEntryRevision === word.entry.revision
      && (session.revealedEntryId ?? session.entryIds[session.currentIndex]) === word.entry.id
    const answer = word && revealed ? word.entry : undefined
    const counts = store.db.prepare(`SELECT count(*) AS rated,
      count(json_extract(body, '$.previousCardState')) AS dueRated
      FROM review_events WHERE json_extract(body, '$.sessionId')=?`).get(session.sessionId) as { rated: number; dueRated: number }
    const { entryIds, wordIds: _wordIds, ...cursor } = session
    return { session: { ...cursor, total: entryIds.length }, revealed, ...counts, firstRecallRated: counts.rated - counts.dueRated, word: word && { prompt: word.prompt, card: !!word.card,
      entryRevision: word.entry.revision, answer } }
  }

  return {
    openSession() {
      const session = store.openReview()
      return session && { sessionId: session.sessionId, deckId: session.deckId, listId: session.listId, revision: session.revision, status: session.status }
    },
    overview(deckId: string | undefined, now: number, listId?: string) {
      const { decks, due, firstRecall, nextDueAt, progress, listStats, deckStats } = queue(deckId, now, listId)
      const { timezone, reviewResetMinutes } = store.settings()
      const [learnStart, learnEnd] = dayBounds(now, timezone)
      const [start, reviewEnd] = reviewDayBounds(now, timezone, reviewResetMinutes)
      const { ratedToday, reviewedWordsToday } = store.db.prepare(`SELECT count(*) AS ratedToday,
        count(DISTINCT link.word_id) AS reviewedWordsToday
        FROM review_events e LEFT JOIN word_cards link ON link.card_id=e.card_id
        WHERE e.reviewed_at >= ? AND e.reviewed_at < ? AND e.reviewed_at <= ?
        ${deckId ? "AND json_extract(e.body, '$.deckId')=?" : ''}
        ${listId ? "AND json_extract(e.body, '$.listId')=?" : ''}`)
        .get(start, reviewEnd, now, ...(deckId ? [deckId] : []), ...(listId ? [listId] : [])) as
        { ratedToday: number; reviewedWordsToday: number }
      return { decks, due, firstRecall, nextDueAt, ratedToday, reviewedWordsToday,
        nextDayAt: Math.min(learnEnd, reviewEnd), checkedAt: now, listStats, learnedTotal: progress.length,
        deckStats: [...deckStats].map(([deckId, stats]) => ({ deckId, ...stats })),
        learnedToday: progress.filter(({ firstCompletedAt }) => firstCompletedAt >= learnStart && firstCompletedAt <= now).length }
    },
    round(deckId: string | undefined, now: number, sessionId?: string, listId?: string) {
      const open = store.openReview()
      const selected = sessionId ? store.review(sessionId) : open && open.deckId === deckId && open.listId === listId ? open
        : store.one<Versioned<ReviewSession>>(
          "SELECT body FROM review_sessions WHERE deck_id IS ? AND json_extract(body, '$.listId') IS ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
          deckId ?? null, listId ?? null)
      return snapshot(selected && selected.deckId === deckId && selected.listId === listId ? selected : undefined, now)
    },
    legacyRound(deckId: string | undefined, now: number) {
      const session = store.openReview() ?? store.one<Versioned<ReviewSession>>(
        'SELECT body FROM review_sessions WHERE deck_id IS ? ORDER BY updated_at DESC, rowid DESC LIMIT 1', deckId ?? null)
      return snapshot(session?.status === 'abandoned' ? undefined : session, now)
    },
    start(deckId: string | undefined, now: number, resume = false, studyFlowId?: string, listId?: string) {
      const open = store.openReview()
      if (open && (open.deckId !== deckId || open.listId !== listId)) return {
        kind: 'conflict' as const,
        session: { sessionId: open.sessionId, deckId: open.deckId, listId: open.listId, status: open.status, revision: open.revision },
      }
      if (open) {
        const updated = resume ? reconcile({ ...open, status: 'active', updatedAt: now,
          studyFlowId: studyFlowId ?? open.studyFlowId }, now) : open
        const changed = resume && (updated.status !== open.status || updated.currentIndex !== open.currentIndex
          || updated.currentRevealed !== open.currentRevealed || updated.currentCardId !== open.currentCardId || updated.studyFlowId !== open.studyFlowId)
        return { kind: 'round' as const, round: snapshot(changed ? store.saveReview(updated) : open, now)! }
      }
      const { items } = queue(deckId, now, listId)
      if (!items.length) return { kind: 'empty' as const }
      const session = store.saveReview({ sessionId: randomUUID(), deckId, listId, studyFlowId, entryIds: items.map(({ entryId }) => entryId),
        wordIds: items.map(({ wordId }) => wordId), currentIndex: 0, currentCardId: items[0].cardId, currentRevealed: false,
        startedAt: now, updatedAt: now, status: 'active' })
      return { kind: 'round' as const, round: snapshot(session, now)! }
    },
    repair(id: string, revision: number, now: number) {
      const session = requireSession(id, revision)
      const updated = reconcile(session, now)
      if (updated !== session) store.saveReview(updated)
    },
    setStatus(id: string, status: 'active' | 'paused' | 'abandoned', revision: number, now: number) {
      const session = { ...requireSession(id, revision), status, updatedAt: now }
      store.saveReview(status === 'active' ? reconcile(session, now) : session)
    },
    reveal(id: string, cardId: string, entryRevision: number, revision: number, now: number) {
      const session = requireSession(id, revision)
      const word = requireTarget(session, cardId, now)
      checkRevision(word.entry, entryRevision)
      store.saveReview({ ...session, currentRevealed: true, revealedEntryRevision: entryRevision, revealedEntryId: word.entry.id, updatedAt: now })
    },
    score(id: string, cardId: string, rating: ReviewRating, revision: number, now: number) {
      const session = requireSession(id, revision)
      const { card: previous, entry, wordId } = requireTarget(session, cardId, now)
      if (!session.currentRevealed || session.revealedEntryRevision !== entry.revision
        || (session.revealedEntryId ?? session.entryIds[session.currentIndex]) !== entry.id) {
        throw new StudyError('Reveal the current answer before rating it.', 409)
      }
      if (now <= (previous?.schedulerState.lastReviewAt ?? -1)) {
        throw new StudyError('Server time has not advanced past the last review.', 409)
      }
      const time = new Date(now)
      const card = previous ? restoreCard(previous.schedulerState) : engine.newCard({ now: time, cardId })
      const { card: scheduled, revlog } = engine.review({ card, grade: schedulerGrades[rating], now: time })
      const state = serializeCard(scheduled)
      const event: ReviewEvent = {
        id: randomUUID(), cardId, entryId: entry.id, deckId: entry.deckId, sessionId: id, direction: REVIEW_DIRECTION,
        rating, reviewedAt: now, schedulerModel: FSRS_MODEL,
        schedulerConfigVersion: config.version, schedulerConfigSnapshot: config, previousCardState: previous?.schedulerState,
        resultingCardState: state, schedulerRevlog: serializeRevlog(revlog, rating),
      }
      store.addReview(event)
      store.saveCard({
        id: cardId, entryId: previous?.entryId ?? entry.id, deckId: previous?.deckId ?? entry.deckId, direction: REVIEW_DIRECTION,
        revision: (previous?.revision ?? 0) + 1, lastEventId: event.id, createdAt: previous?.createdAt ?? now, updatedAt: now,
        schedulerConfigVersion: config.version, schedulerState: state, dueAt: state.dueAt, scheduleStatus: state.scheduleStatus,
      })
      if (!previous) store.linkCard({ cardId, wordId, direction: REVIEW_DIRECTION, active: true })
      const next = store.saveReview(reconcile(move(session, session.currentIndex + 1, now), now))
      return { event, round: snapshot(next, now) }
    },
  }
}
