import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reviewCardId } from '../../../shared/domain/review'
import type { LibraryExport } from '../../../shared/contracts/library'
import * as schedulerModule from '../../../shared/srs/scheduler'
import { createReviewScheduler, rebuildCardFromEvents, restoreCard, schedulerGrades } from '../../../shared/srs/scheduler'
import { LexynLocalDatabase } from '../../db/local'
import { createLearnRepository } from '../learn/repository'
import { createLibraryRepository } from '../library/repository'
import { createReviewRepository, localDayBounds } from './repository'

const now = new Date(2026, 0, 11, 23, 50).getTime()
let database: LexynLocalDatabase
let library: ReturnType<typeof createLibraryRepository>
let learn: ReturnType<typeof createLearnRepository>
let review: ReturnType<typeof createReviewRepository>
let deckId: string

beforeEach(async () => {
  database = new LexynLocalDatabase(`lexyn-review-test-${crypto.randomUUID()}`)
  library = createLibraryRepository(database)
  learn = createLearnRepository(database)
  review = createReviewRepository(database)
  deckId = (await library.createDeck({ name: 'Systems' })).id
})

afterEach(async () => {
  vi.restoreAllMocks()
  await database.delete()
})

async function addLearned(term: string, meaning = '中文释义', deck = deckId) {
  const word = await library.createEntry(deck, { term, meaning })
  const session = await learn.startSession(deck, 'copy', [word.id], true, now)
  await learn.recordAttempt(session.sessionId, term, true, now, word.id)
  await learn.finishCurrent(session.sessionId, 'completed', now, 0, word.id)
  return word
}

async function startAndReveal(at = now, deck: string | undefined = deckId) {
  await review.start(deck, at)
  const round = await review.round(deck, at)
  const { session, word } = round!
  const cardId = session.currentCardId!
  await review.reveal(session.sessionId, cardId, word!.entry.revision, at)
  return { sessionId: session.sessionId, cardId }
}

test('only learned words with usable Chinese prompts enter first recall, separately from due cards', async () => {
  await library.createEntry(deckId, { term: 'untouched', meaning: '未学习' })
  await addLearned('no-gloss', '   ')
  await addLearned('english-only', 'An English definition')
  const word = await addLearned('copy-on-write', 'Copy-on-write 写时复制')
  expect(await database.practice_events.count()).toBe(3)
  expect(await database.review_cards.count()).toBe(0)
  expect(await database.review_events.count()).toBe(0)
  expect(await review.overview(deckId, now)).toMatchObject({ due: 0, firstRecall: 1, ratedToday: 0, learnedToday: 3 })
  await review.start(deckId, now)
  expect(await review.round(deckId, now)).toMatchObject({
    session: { entryIds: [word.id] }, revealed: false, word: { prompt: '… 写时复制' },
  })
})

test('requires reveal and atomically scores at most once even when two requests race', async () => {
  const word = await addLearned('concurrency', '并发')
  await Promise.all([review.start(deckId, now), review.start(deckId, now)])
  const { session } = (await review.round(deckId, now))!
  const cardId = reviewCardId(word.id)
  await expect(review.score(session.sessionId, cardId, 'good', now)).rejects.toThrow('Reveal')
  await review.reveal(session.sessionId, cardId, word.revision, now)
  const sequence = Number((await database.sync_meta.get('library.outbox.sequence'))?.value)
  const results = await Promise.all([
    review.score(session.sessionId, cardId, 'good', now),
    review.score(session.sessionId, cardId, 'easy', now),
  ])
  expect(results[0]).toEqual(results[1])
  const event = results[0]
  expect(await database.review_sessions.count()).toBe(1)
  expect(await database.review_events.toArray()).toEqual([event])
  expect(await database.review_cards.toArray()).toMatchObject([
    { id: cardId, entryId: word.id, lastEventId: event.id, revision: 1, schedulerState: event.resultingCardState },
  ])
  expect(await review.round(deckId, now)).toMatchObject({ session: { status: 'completed' }, rated: 1 })
  expect((await database.client_outbox.orderBy('sequence').last())).toMatchObject({
    entityId: cardId, kind: 'review.create', sequence: sequence + 1, payload: event,
  })
  expect(event).not.toHaveProperty('answer')
})

test('keeps the revealed card and rolls back every write when the outbox fails, then retries', async () => {
  await addLearned('deadlock', '死锁')
  const { sessionId, cardId } = await startAndReveal()
  const session = await database.review_sessions.get(sessionId)
  const outbox = await database.client_outbox.toArray()
  const meta = await database.sync_meta.toArray()
  vi.spyOn(database.client_outbox, 'bulkAdd').mockRejectedValueOnce(new Error('outbox failed'))
  await expect(review.score(sessionId, cardId, 'again', now)).rejects.toThrow('outbox failed')
  expect(await database.review_events.count()).toBe(0)
  expect(await database.review_cards.count()).toBe(0)
  expect(await database.review_sessions.get(sessionId)).toEqual(session)
  expect(await database.client_outbox.toArray()).toEqual(outbox)
  expect(await database.sync_meta.toArray()).toEqual(meta)
  expect(await review.round(deckId, now)).toMatchObject({ revealed: true })
  await expect(review.score(sessionId, cardId, 'again', now)).resolves.toMatchObject({ rating: 'again' })
})

test('Again is only eligible at the actual FSRS due time and reuses the existing card', async () => {
  const word = await addLearned('snapshot', '快照')
  const firstRound = await startAndReveal()
  const { cardId } = firstRound
  const first = await review.score(firstRound.sessionId, cardId, 'again', now)
  const due = first.resultingCardState.dueAt
  const scheduler = await createReviewScheduler()
  const time = new Date(now)
  const expected = scheduler.review({ card: scheduler.newCard({ now: time, cardId }), grade: schedulerGrades.again, now: time })
  expect(due).toBe(expected.card.dueAt.getTime())
  expect(await review.overview(deckId, due - 1)).toMatchObject({ due: 0, firstRecall: 0, nextDueAt: due })
  await review.start(deckId, due - 1)
  expect(await database.review_sessions.count()).toBe(1)
  expect(await review.overview(deckId, due)).toMatchObject({ due: 1, firstRecall: 0 })
  const secondRound = await startAndReveal(due)
  const second = await review.score(secondRound.sessionId, cardId, 'good', due)
  const projection = await database.review_cards.get(reviewCardId(word.id))
  expect(await database.review_cards.count()).toBe(1)
  expect(projection).toMatchObject({ revision: 2, schedulerState: second.resultingCardState })
  expect(await rebuildCardFromEvents([second, first])).toEqual(projection?.schedulerState)
})

test('prioritizes due learning cards, then due reviews, then first recalls and honors deck scope', async () => {
  const other = (await library.createDeck({ name: 'Other' })).id
  const learned = await addLearned('common', '相同', other)
  const firstRound = await startAndReveal(now, other)
  const long = await review.score(firstRound.sessionId, firstRound.cardId, 'easy', now)
  const learning = await addLearned('common', '共用')
  const secondRound = await startAndReveal()
  const short = await review.score(secondRound.sessionId, secondRound.cardId, 'again', now)
  const firstRecall = await addLearned('new', '新增')
  const at = Math.max(short.resultingCardState.dueAt, long.resultingCardState.dueAt)
  expect(await review.overview(other, at)).toMatchObject({ due: 1, firstRecall: 0 })
  expect(await review.overview(undefined, at)).toMatchObject({ due: 2, firstRecall: 1 })
  await review.start(undefined, at)
  expect((await review.round(undefined, at))?.session.entryIds).toEqual([learning.id, learned.id, firstRecall.id])
})

test('restores paused reveal and keeps history when a card is removed or its deck is archived', async () => {
  const rated = await addLearned('atomic', '原子')
  const { sessionId, cardId } = await startAndReveal()
  await review.setStatus(sessionId, 'paused', now)
  database.close()
  await database.open()
  expect(await review.round(deckId, now)).toMatchObject({ session: { status: 'paused', currentRevealed: true } })
  await review.setStatus(sessionId, 'active', now)
  expect(await review.round(deckId, now)).toMatchObject({ revealed: true })
  const saved = await review.score(sessionId, cardId, 'again', now)
  const pending = await addLearned('another', '另一个')
  const due = saved.resultingCardState.dueAt
  await review.start(deckId, due)
  const round = (await review.round(deckId, due))!
  await library.setEntryRemoved(deckId, rated.id, true)
  await review.repair(round.session.sessionId, cardId, due)
  expect((await review.round(deckId, due))?.word?.entry.id).toBe(pending.id)
  await library.setDeckArchived(deckId, true)
  await review.repair(round.session.sessionId, reviewCardId(pending.id), due)
  expect(await review.round(deckId, due)).toMatchObject({ session: { status: 'completed' }, rated: 0 })
  expect(await database.review_events.toArray()).toEqual([saved])
  expect(await database.review_cards.count()).toBe(1)
  await library.setDeckArchived(deckId, false)
  await library.setEntryRemoved(deckId, rated.id, false)
  expect(await review.overview(deckId, due)).toMatchObject({ due: 1, firstRecall: 1 })
})

test('invalidates a reveal when the entry changes and can reveal the updated answer', async () => {
  const word = await addLearned('typo', '原释义')
  const { sessionId, cardId } = await startAndReveal()
  await library.updateEntry(deckId, word.id, { term: 'spelling', meaning: '拼写' })
  await expect(review.score(sessionId, cardId, 'easy', now)).rejects.toThrow('word changed')
  const round = (await review.round(deckId, now))!
  expect(round.revealed).toBe(false)
  await review.reveal(sessionId, cardId, round.word!.entry.revision, now)
  await expect(review.score(sessionId, cardId, 'easy', now)).resolves.toMatchObject({ entryId: word.id })
})

test('exports complete archived review history in v3 and scopes deck exports', async () => {
  const word = await addLearned('backup', '备份')
  const { sessionId, cardId } = await startAndReveal()
  const event = await review.score(sessionId, cardId, 'hard', now)
  await library.setEntryRemoved(deckId, word.id, true)
  await library.setDeckArchived(deckId, true)
  const other = (await library.createDeck({ name: 'Other' })).id
  await addLearned('outside', '其他', other)
  const next = await startAndReveal(now, other)
  await review.score(next.sessionId, next.cardId, 'easy', now)
  const exported: LibraryExport = JSON.parse(JSON.stringify(await library.exportLibrary(deckId)))
  expect(exported).toMatchObject({
    format: 'lexyn-library', formatVersion: 3, metadata: { librarySchemaVersion: 4, scope: 'deck' },
    decks: [{ id: deckId, archivedAt: expect.any(Number) }],
    entries: [{ id: word.id, deletedAt: expect.any(Number) }],
    practiceEvents: [{ entryId: word.id }], learnProgress: [{ entryId: word.id }],
    reviewCards: [{ id: cardId, dueAt: event.resultingCardState.dueAt }],
    reviewEvents: [{ id: event.id, schedulerConfigSnapshot: exported.schedulerConfig, schedulerRevlog: { reviewTime: now } }],
  })
  expect(new Date(exported.exportedAt).toISOString()).toBe(exported.exportedAt)
  expect(await rebuildCardFromEvents(exported.reviewEvents)).toEqual(exported.reviewCards[0].schedulerState)
  expect(restoreCard(exported.reviewCards[0].schedulerState).dueAt.getTime()).toBe(exported.reviewCards[0].dueAt)
  expect((await library.exportLibrary()).reviewEvents).toHaveLength(2)
})

test('counts ratings by local calendar day while due and event times remain UTC milliseconds', async () => {
  await addLearned('midnight', '午夜')
  const { sessionId, cardId } = await startAndReveal()
  const [, midnight] = localDayBounds(now)
  const event = await review.score(sessionId, cardId, 'again', midnight - 1)
  expect(await review.overview(undefined, midnight - 1)).toMatchObject({ ratedToday: 1, learnedToday: 1 })
  expect(await review.overview(undefined, midnight)).toMatchObject({ ratedToday: 0, learnedToday: 0, due: 0 })
  expect(event.reviewedAt).toBe(midnight - 1)
  expect(await review.overview(undefined, event.resultingCardState.dueAt)).toMatchObject({ due: 1 })
})

test('upgrades a real v3 database without changing preferences, progress, events, sessions or outbox', async () => {
  const word = await addLearned('legacy', '旧词')
  await database.preferences.put({ key: 'daily-new-words', value: 17 })
  const oldData = {
    preferences: await database.preferences.toArray(),
    decks: await database.decks.toArray(),
    entries: await database.entries.toArray(),
    practice_events: await database.practice_events.toArray(),
    learn_progress: await database.learn_progress.toArray(),
    learn_sessions: await database.learn_sessions.toArray(),
    client_outbox: await database.client_outbox.toArray(),
    sync_meta: await database.sync_meta.toArray(),
  }
  const name = `${database.name}-v3`
  const legacy = new Dexie(name)
  legacy.version(3).stores({
    preferences: 'key', sync_meta: 'key', client_outbox: 'operationId, createdAt, &sequence',
    decks: 'id', entries: 'id, deckId, &[deckId+activeTerm]',
    practice_events: 'id, deckId, entryId, sessionId, startedAt, completedAt, [entryId+completedAt], [deckId+completedAt]',
    learn_progress: 'entryId, firstCompletedAt, lastPracticedAt',
    learn_sessions: 'sessionId, deckId, status, updatedAt',
  })
  const upgraded = new LexynLocalDatabase(name)
  try {
    await legacy.open()
    for (const [table, data] of Object.entries(oldData)) await legacy.table(table).bulkAdd(data)
    legacy.close()
    await upgraded.open()
    expect(upgraded.verno).toBe(5)
    for (const [table, data] of Object.entries(oldData)) expect(await upgraded.table(table).toArray()).toEqual(data)
    expect(await upgraded.review_cards.count()).toBe(0)
    expect(await upgraded.review_events.count()).toBe(0)
    expect(await createReviewRepository(upgraded).overview(word.deckId, now)).toMatchObject({ firstRecall: 1, due: 0 })
  } finally {
    legacy.close()
    await upgraded.delete()
  }
})

test('does not commit a calculation based on a projection revised between read and write', async () => {
  await addLearned('versioned', '版本')
  const first = await startAndReveal()
  const saved = await review.score(first.sessionId, first.cardId, 'again', now)
  const due = saved.resultingCardState.dueAt
  const next = await startAndReveal(due)
  const engine = await createReviewScheduler()
  let concurrentWrite: Promise<number> | undefined
  vi.spyOn(schedulerModule, 'createReviewScheduler').mockResolvedValueOnce({
    ...engine,
    review(args) {
      concurrentWrite ??= database.review_cards.update(next.cardId, { revision: 2 })
      return engine.review(args)
    },
  })
  const otherTab = createReviewRepository(database)
  const operations = await database.client_outbox.count()
  await expect(otherTab.score(next.sessionId, next.cardId, 'good', due)).rejects.toThrow('changed during saving')
  await concurrentWrite
  expect(await database.review_events.toArray()).toEqual([saved])
  expect(await database.client_outbox.count()).toBe(operations)
  expect(await review.round(deckId, due)).toMatchObject({ revealed: true })
  await expect(otherTab.score(next.sessionId, next.cardId, 'good', due)).resolves.toMatchObject({ rating: 'good' })
})

test('abandoning an open round retains its ratings and allows a new queue', async () => {
  await addLearned('first', '第一个')
  await addLearned('second', '第二个')
  const { sessionId, cardId } = await startAndReveal()
  const saved = await review.score(sessionId, cardId, 'good', now)
  await review.setStatus(sessionId, 'abandoned', now)
  expect(await review.round(deckId, now)).toBeNull()
  expect(await database.review_events.toArray()).toEqual([saved])
  await review.start(deckId, now)
  expect(await review.round(deckId, now)).toMatchObject({
    session: { status: 'active', currentIndex: 0, entryIds: [expect.any(String)] }, rated: 0,
  })
})
