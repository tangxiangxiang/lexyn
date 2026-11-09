import {
  REVIEW_DIRECTION, recallPrompt, reviewCardId,
  type ReviewCard, type ReviewEvent, type ReviewRating, type ReviewSession,
} from '../../../shared/domain/review'
import {
  FSRS_MODEL, createReviewScheduler, isReviewRating, restoreCard, schedulerConfigSnapshot,
  schedulerGrades, serializeCard, serializeRevlog,
} from '../../../shared/srs/scheduler'
import { db, type LexynLocalDatabase } from '../../db/local'
import { appendOutboxOperations } from '../library/repository'

export class ReviewError extends Error {}

export function localDayBounds(now: number) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 1)
  return [start.getTime(), end.getTime()] as const
}

interface QueueItem {
  entryId: string
  priority: number
  dueAt: number
}

export function createReviewRepository(database: LexynLocalDatabase) {
  const { decks, entries, learn_progress, review_cards, review_events, review_sessions, client_outbox, sync_meta } = database
  const eligibilityTables = [decks, entries, learn_progress, review_cards]
  const roundTables = [...eligibilityTables, review_sessions, review_events]
  const openSession = () => review_sessions.where('status').anyOf('active', 'paused').first()
  let scheduler: ReturnType<typeof createReviewScheduler> | undefined

  async function queue(deckId: string | undefined, now: number) {
    const [allDecks, words, progress, cards] = await Promise.all([
      decks.toArray(),
      deckId === undefined ? entries.toArray() : entries.where('deckId').equals(deckId).toArray(),
      learn_progress.toArray(),
      deckId === undefined ? review_cards.toArray() : review_cards.where('deckId').equals(deckId).toArray(),
    ])
    const activeDecks = allDecks.filter((deck) => deck.archivedAt === undefined)
    const activeDeckIds = new Set(activeDecks.map(({ id }) => id))
    const learned = new Set(progress.filter((item) => item.firstCompletedAt !== undefined).map(({ entryId }) => entryId))
    const projections = new Map(cards.map((card) => [card.id, card]))
    const items: QueueItem[] = []
    let due = 0
    let firstRecall = 0
    let nextDueAt: number | undefined
    for (const word of words) {
      if (word.deletedAt !== undefined || !activeDeckIds.has(word.deckId) || !learned.has(word.id)
        || !recallPrompt(word.meaning, word.term)) continue
      const card = projections.get(reviewCardId(word.id))
      if (!card) {
        firstRecall++
        items.push({ entryId: word.id, priority: 2, dueAt: 0 })
      } else if (card.dueAt <= now) {
        due++
        items.push({ entryId: word.id, priority: card.scheduleStatus === 'learning' ? 0 : 1, dueAt: card.dueAt })
      } else {
        nextDueAt = Math.min(nextDueAt ?? card.dueAt, card.dueAt)
      }
    }
    items.sort((a, b) => a.priority - b.priority || a.dueAt - b.dueAt || a.entryId.localeCompare(b.entryId))
    return { activeDecks, items, due, firstRecall, nextDueAt, progress }
  }

  async function target(entryId: string | undefined, now: number) {
    if (!entryId) return undefined
    const entry = await entries.get(entryId)
    if (!entry || entry.deletedAt !== undefined) return undefined
    const prompt = recallPrompt(entry.meaning, entry.term)
    if (!prompt) return undefined
    const [deck, progress, card] = await Promise.all([
      decks.get(entry.deckId), learn_progress.get(entryId), review_cards.get(reviewCardId(entryId)),
    ])
    if (!deck || deck.archivedAt !== undefined || progress?.firstCompletedAt === undefined
      || (card && card.dueAt > now)) return undefined
    return { entry, prompt, card }
  }

  function move(session: ReviewSession, index: number, now: number): ReviewSession {
    const entryId = session.entryIds[index]
    return {
      ...session, currentIndex: index, updatedAt: now,
      currentCardId: entryId ? reviewCardId(entryId) : undefined,
      currentRevealed: false, revealedEntryRevision: undefined,
      status: entryId ? session.status : 'completed',
    }
  }

  async function reconcile(session: ReviewSession, now: number) {
    let index = session.currentIndex
    while (index < session.entryIds.length && !await target(session.entryIds[index], now)) index++
    if (index !== session.currentIndex || !session.currentCardId) return move(session, index, now)
    return session
  }

  const recorded = (sessionId: string, cardId: string) => review_events.get({ sessionId, cardId })

  async function scoreTarget(sessionId: string, cardId: string, now: number) {
    const session = await review_sessions.get(sessionId)
    if (session?.status !== 'active' || session.currentCardId !== cardId || !session.currentRevealed) {
      throw new ReviewError('This card is no longer ready to rate. Reveal the current answer to continue.')
    }
    const word = await target(session.entryIds[session.currentIndex], now)
    if (!word || word.entry.revision !== session.revealedEntryRevision) {
      throw new ReviewError('The word changed while you were reviewing it. Reveal the current answer again.')
    }
    return { session, ...word }
  }

  return {
    overview: (deckId: string | undefined, now = Date.now()) =>
      database.transaction('r', [...eligibilityTables, review_events], async () => {
        const { activeDecks, due, firstRecall, nextDueAt, progress } = await queue(deckId, now)
        const [start, end] = localDayBounds(now)
        const reviews = review_events.where('reviewedAt').between(start, end, true, false)
        if (deckId !== undefined) reviews.and((event) => event.deckId === deckId)
        return {
          decks: activeDecks, due, firstRecall, nextDueAt, ratedToday: await reviews.count(),
          learnedToday: progress.filter(({ firstCompletedAt }) =>
            firstCompletedAt !== undefined && firstCompletedAt >= start && firstCompletedAt < end).length,
        }
      }),

    round: (deckId: string | undefined, now = Date.now()) =>
      database.transaction('r', roundTables, async () => {
        const open = await openSession()
        const session = open ?? await review_sessions.orderBy('updatedAt').reverse()
          .filter((item) => item.deckId === deckId).first()
        if (!session || session.status === 'abandoned') return null
        const word = session.status === 'active' ? await target(session.entryIds[session.currentIndex], now) : undefined
        return {
          session, word,
          revealed: !!word && session.currentRevealed && session.revealedEntryRevision === word.entry.revision,
          rated: await review_events.where('sessionId').equals(session.sessionId).count(),
        }
      }),

    start: (deckId: string | undefined, now = Date.now()) =>
      database.transaction('rw', [...eligibilityTables, review_sessions], async () => {
        if (await openSession()) return
        const { items } = await queue(deckId, now)
        if (!items.length) return
        await review_sessions.add({
          sessionId: crypto.randomUUID(), deckId, entryIds: items.map(({ entryId }) => entryId),
          currentIndex: 0, currentCardId: reviewCardId(items[0].entryId), currentRevealed: false,
          startedAt: now, updatedAt: now, status: 'active',
        })
      }),

    repair: (sessionId: string, cardId: string | undefined, now = Date.now()) =>
      database.transaction('rw', [...eligibilityTables, review_sessions], async () => {
        const session = await review_sessions.get(sessionId)
        if (session?.status !== 'active' || session.currentCardId !== cardId) return
        const updated = await reconcile(session, now)
        if (updated !== session) await review_sessions.put(updated)
      }),

    setStatus: (sessionId: string, status: 'active' | 'paused' | 'abandoned', now = Date.now()) =>
      database.transaction('rw', [...eligibilityTables, review_sessions], async () => {
        const session = await review_sessions.get(sessionId)
        if (!session || session.status === 'completed' || session.status === 'abandoned') return
        const updated = { ...session, status, updatedAt: now }
        await review_sessions.put(status === 'active' ? await reconcile(updated, now) : updated)
      }),

    reveal: (sessionId: string, cardId: string, entryRevision: number, now = Date.now()) =>
      database.transaction('rw', [...eligibilityTables, review_sessions], async () => {
        const session = await review_sessions.get(sessionId)
        if (session?.status !== 'active' || session.currentCardId !== cardId) return
        const word = await target(session.entryIds[session.currentIndex], now)
        if (!word || word.entry.revision !== entryRevision) throw new ReviewError('The word changed. Try again.')
        if (session.currentRevealed && session.revealedEntryRevision === entryRevision) return
        await review_sessions.put({ ...session, currentRevealed: true, revealedEntryRevision: entryRevision, updatedAt: now })
      }),

    score: async (sessionId: string, cardId: string, rating: ReviewRating, now = Date.now()) => {
      if (!isReviewRating(rating)) throw new ReviewError('Choose one of the four recall ratings.')
      scheduler ??= createReviewScheduler().catch((error) => { scheduler = undefined; throw error })
      const engine = await scheduler
      const snapshot = await database.transaction('r', roundTables, async () => {
        const event = await recorded(sessionId, cardId)
        return event ? { event } : { target: await scoreTarget(sessionId, cardId, now) }
      })
      if (snapshot.event) return snapshot.event
      const { card: previous, entry } = snapshot.target
      const time = new Date(now)
      const card = previous ? restoreCard(previous.schedulerState) : engine.newCard({ now: time, cardId })
      const { card: scheduled, revlog } = engine.review({ card, grade: schedulerGrades[rating], now: time })
      const config = schedulerConfigSnapshot(engine)
      const state = serializeCard(scheduled)
      const event: ReviewEvent = {
        id: crypto.randomUUID(), cardId, entryId: entry.id, deckId: entry.deckId, sessionId,
        direction: REVIEW_DIRECTION, rating, reviewedAt: now, schedulerModel: FSRS_MODEL,
        schedulerConfigVersion: config.version, schedulerConfigSnapshot: config,
        previousCardState: previous?.schedulerState, resultingCardState: state,
        schedulerRevlog: serializeRevlog(revlog, rating),
      }
      return database.transaction('rw', [...roundTables, client_outbox, sync_meta], async () => {
        const existing = await recorded(sessionId, cardId)
        if (existing) return existing
        const latest = await scoreTarget(sessionId, cardId, now)
        if (latest.card?.revision !== previous?.revision || latest.card?.lastEventId !== previous?.lastEventId
          || latest.entry.revision !== entry.revision) {
          throw new ReviewError('The card changed during saving. Check the current answer and rate it again.')
        }
        await review_events.add(event)
        await review_cards.put({
          id: cardId, entryId: entry.id, deckId: entry.deckId, direction: REVIEW_DIRECTION,
          revision: (previous?.revision ?? 0) + 1, lastEventId: event.id,
          createdAt: previous?.createdAt ?? now, updatedAt: now,
          schedulerConfigVersion: config.version, schedulerState: state, dueAt: state.dueAt, scheduleStatus: state.scheduleStatus,
        })
        await review_sessions.put(await reconcile(move(latest.session, latest.session.currentIndex + 1, now), now))
        await appendOutboxOperations(database, [{
          opId: event.id, schemaVersion: 1, entityId: cardId, kind: 'review.create', payload: event, baseRevision: 0,
        }], now)
        return event
      })
    },
  }
}

export const review = createReviewRepository(db)
