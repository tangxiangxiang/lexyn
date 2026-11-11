import { randomUUID } from 'node:crypto'
import { REVIEW_DIRECTION, recallPrompt, reviewCardId, type ReviewEvent, type ReviewRating, type ReviewSession } from '../../shared/domain/review.ts'
import { FSRS_MODEL, restoreCard, schedulerConfigSnapshot, schedulerGrades, serializeCard, serializeRevlog, type ReviewScheduler } from '../../shared/srs/scheduler.ts'
import { dayBounds } from './calendar.ts'
import { checkRevision, StudyError, type StudyStore, type Versioned } from './store.ts'

export function createReviewService(store: StudyStore, engine: ReviewScheduler) {
  const config = schedulerConfigSnapshot(engine)

  function queue(deckId: string | undefined, now: number) {
    const decks = store.decks().filter((deck) => deck.archivedAt === undefined)
    const active = new Set(decks.map(({ id }) => id))
    const progress = store.progress()
    const learned = new Set(progress.filter((row) => row.firstCompletedAt !== undefined).map(({ entryId }) => entryId))
    const cards = new Map(store.cards().map((card) => [card.id, card]))
    const listByEntry = new Map<string, string>()
    for (const row of store.db.prepare('SELECT entry_id AS entryId, list_id AS listId FROM deck_list_members').all() as { entryId: string; listId: string }[]) {
      listByEntry.set(row.entryId, row.listId)
    }
    const listStats = new Map<string, { due: number; firstRecall: number; nextDueAt?: number }>()
    const items: { entryId: string; dueAt: number; priority: number }[] = []
    let due = 0
    let firstRecall = 0
    let nextDueAt: number | undefined
    for (const entry of store.entries(deckId)) {
      if (entry.deletedAt !== undefined || !active.has(entry.deckId) || !learned.has(entry.id)
        || !recallPrompt(entry.meaning, entry.term)) continue
      const listId = listByEntry.get(entry.id)
      const stats = listId ? (listStats.get(listId) ?? { due: 0, firstRecall: 0 }) : undefined
      const card = cards.get(reviewCardId(entry.id))
      if (!card) {
        firstRecall++
        if (stats) stats.firstRecall++
        items.push({ entryId: entry.id, dueAt: 0, priority: 2 })
      } else if (card.dueAt <= now) {
        due++
        if (stats) stats.due++
        items.push({ entryId: entry.id, dueAt: card.dueAt, priority: card.scheduleStatus === 'learning' ? 0 : 1 })
      } else {
        nextDueAt = Math.min(nextDueAt ?? card.dueAt, card.dueAt)
        if (stats) stats.nextDueAt = Math.min(stats.nextDueAt ?? card.dueAt, card.dueAt)
      }
      if (listId) listStats.set(listId, stats!)
    }
    items.sort((a, b) => a.priority - b.priority || a.dueAt - b.dueAt || a.entryId.localeCompare(b.entryId))
    return { decks, items, due, firstRecall, nextDueAt, progress,
      listStats: [...listStats].map(([listId, stats]) => ({ listId, ...stats })) }
  }

  function target(id: string | undefined, now: number) {
    if (!id) return
    const entry = store.entry(id)
    if (!entry || entry.deletedAt !== undefined) return
    const prompt = recallPrompt(entry.meaning, entry.term)
    const deck = store.deck(entry.deckId)
    const progress = store.entryProgress(id)
    const card = store.card(reviewCardId(id))
    if (!prompt || !deck || deck.archivedAt !== undefined || progress?.firstCompletedAt === undefined
      || (card && card.dueAt > now)) return
    return { entry, prompt, card }
  }

  function move(session: Versioned<ReviewSession>, index: number, now: number): Versioned<ReviewSession> {
    const id = session.entryIds[index]
    return { ...session, currentIndex: index, updatedAt: now, currentCardId: id ? reviewCardId(id) : undefined,
      currentRevealed: false, revealedEntryRevision: undefined, status: id ? session.status : 'completed' }
  }

  function reconcile(session: Versioned<ReviewSession>, now: number) {
    let index = session.currentIndex
    while (index < session.entryIds.length && !target(session.entryIds[index], now)) index++
    return index !== session.currentIndex || !session.currentCardId ? move(session, index, now) : session
  }

  function requireSession(id: string, revision: number) {
    const session = store.review(id)
    checkRevision(session, revision)
    if (!session || (session.status !== 'active' && session.status !== 'paused')) {
      throw new StudyError('This Review session is no longer active.', 409)
    }
    return session
  }

  function requireTarget(session: ReviewSession, cardId: string, now: number) {
    const word = target(session.entryIds[session.currentIndex], now)
    if (session.status !== 'active' || session.currentCardId !== cardId || !word) {
      throw new StudyError('The current card changed. Reload the Review session.', 409)
    }
    return word
  }

  function snapshot(session: Versioned<ReviewSession> | undefined, now: number) {
    if (!session || session.status === 'abandoned') return null
    const word = session.status === 'active' ? target(session.entryIds[session.currentIndex], now) : undefined
    const revealed = !!word && session.currentRevealed && session.revealedEntryRevision === word.entry.revision
    const answer = word && revealed ? word.entry : undefined
    const rated = store.db.prepare("SELECT count(*) FROM review_events WHERE json_extract(body, '$.sessionId')=?")
      .pluck().get(session.sessionId) as number
    const { entryIds, ...cursor } = session
    return { session: { ...cursor, total: entryIds.length }, revealed, rated, word: word && { prompt: word.prompt, card: !!word.card,
      entryRevision: word.entry.revision, answer } }
  }

  return {
    overview(deckId: string | undefined, now: number) {
      const { decks, due, firstRecall, nextDueAt, progress, listStats } = queue(deckId, now)
      const [start, nextDayAt] = dayBounds(now, store.settings().timezone)
      const ratedToday = store.db.prepare(`SELECT count(*) FROM review_events
        WHERE reviewed_at >= ? AND reviewed_at < ?
        ${deckId ? "AND json_extract(body, '$.deckId')=?" : ''}`).pluck()
        .get(start, nextDayAt, ...(deckId ? [deckId] : [])) as number
      return { decks, due, firstRecall, nextDueAt, ratedToday, nextDayAt, checkedAt: now,
        listStats,
        learnedToday: progress.filter(({ firstCompletedAt }) => firstCompletedAt !== undefined
          && firstCompletedAt >= start && firstCompletedAt < nextDayAt).length }
    },
    round(deckId: string | undefined, now: number) {
      return snapshot(store.openReview() ?? store.one<Versioned<ReviewSession>>(
        'SELECT body FROM review_sessions WHERE deck_id IS ? ORDER BY updated_at DESC, id LIMIT 1', deckId ?? null), now)
    },
    start(deckId: string | undefined, now: number) {
      if (store.openReview()) return
      const { items } = queue(deckId, now)
      if (!items.length) return
      store.saveReview({ sessionId: randomUUID(), deckId, entryIds: items.map(({ entryId }) => entryId),
        currentIndex: 0, currentCardId: reviewCardId(items[0].entryId), currentRevealed: false,
        startedAt: now, updatedAt: now, status: 'active' })
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
      store.saveReview({ ...session, currentRevealed: true, revealedEntryRevision: entryRevision, updatedAt: now })
    },
    score(id: string, cardId: string, rating: ReviewRating, revision: number, now: number) {
      const session = requireSession(id, revision)
      const { card: previous, entry } = requireTarget(session, cardId, now)
      if (!session.currentRevealed || session.revealedEntryRevision !== entry.revision) {
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
        id: cardId, entryId: entry.id, deckId: entry.deckId, direction: REVIEW_DIRECTION,
        revision: (previous?.revision ?? 0) + 1, lastEventId: event.id, createdAt: previous?.createdAt ?? now, updatedAt: now,
        schedulerConfigVersion: config.version, schedulerState: state, dueAt: state.dueAt, scheduleStatus: state.scheduleStatus,
      })
      const next = store.saveReview(reconcile(move(session, session.currentIndex + 1, now), now))
      return { event, round: snapshot(next, now) }
    },
  }
}
