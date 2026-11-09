import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as scheduler from '../../../shared/srs/scheduler'
import { LexynLocalDatabase } from '../../db/local'
import { createLibraryRepository } from '../library/repository'
import { createLearnRepository } from './repository'

let database: LexynLocalDatabase
let library: ReturnType<typeof createLibraryRepository>
let learn: ReturnType<typeof createLearnRepository>

beforeEach(() => {
  database = new LexynLocalDatabase(`lexyn-learn-test-${crypto.randomUUID()}`)
  library = createLibraryRepository(database)
  learn = createLearnRepository(database)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await database.delete()
})

async function start(terms: string[]) {
  const deck = await library.createDeck({ name: 'Systems' })
  const words = []
  for (const [index, term] of terms.entries()) {
    const entry = await library.createEntry(deck.id, { term, meaning: '' })
    await database.entries.update(entry.id, { createdAt: index })
    words.push(entry)
  }
  const session = await learn.startSession(deck.id, 'dictation', words.map(({ id }) => id), true)
  return { deck, words, sessionId: session.sessionId }
}

test.each([
  { terms: ['first', 'middle', 'last'], index: 0, status: 'active' },
  { terms: ['first', 'middle', 'last'], index: 1, status: 'paused' },
  { terms: ['first', 'middle', 'last'], index: 2, status: 'completed' },
  { terms: ['only'], index: 0, status: 'completed' },
])('removes word at index $index from $terms and leaves the session $status', async ({ terms, index, status }) => {
  const { deck, words, sessionId } = await start(terms)
  for (const word of words.slice(0, index)) {
    await learn.recordAttempt(sessionId, word.term, true)
    await learn.finishCurrent(sessionId, 'completed')
  }
  const removed = words[index]
  await learn.setAssisted(sessionId, removed.id)
  await learn.recordAttempt(sessionId, removed.term, true)
  if (status === 'paused') await learn.setStatus(sessionId, 'paused')
  await library.setEntryRemoved(deck.id, removed.id, true)

  const history = await database.practice_events.toArray()
  const outbox = await database.client_outbox.toArray()
  // Completing a word removed after submission must not create an event.
  if (status === 'completed') {
    expect(await learn.finishCurrent(sessionId, 'completed', 20, index, removed.id)).toBeNull()
  }
  await learn.advanceInvalid(sessionId, removed.id)
  const repaired = await learn.getSession(sessionId)
  await learn.advanceInvalid(sessionId, removed.id)
  expect(await learn.getSession(sessionId)).toEqual(repaired)
  expect(repaired?.session).toMatchObject({
    status,
    currentIndex: Math.min(index, Math.max(0, words.length - 2)),
    entryIds: words.filter(({ id }) => id !== removed.id).map(({ id }) => id),
    currentAssisted: false, currentAttempts: 0,
    firstCompletedEntryIds: words.slice(0, index).map(({ id }) => id),
  })
  expect(repaired?.session.currentLastSubmitted).toBeUndefined()
  expect(repaired?.entry?.id).toBe(status === 'completed' ? undefined : words[index + 1].id)
  expect(await database.practice_events.toArray()).toEqual(history)
  expect(await database.client_outbox.toArray()).toEqual(outbox)
  expect((await learn.getDailyState(deck.id)).completedToday).toBe(index)
  if (status === 'paused') {
    expect(await learn.continueSession(sessionId)).toMatchObject({ status: 'active', currentIndex: index })
  }
})

test('archive pauses the session and restore resumes the same word with its attempt and reveal', async () => {
  const { deck, words: [word], sessionId } = await start(['restore'])
  await learn.setAssisted(sessionId, word.id)
  await learn.recordAttempt(sessionId, 'restor', false)
  await library.setDeckArchived(deck.id, true)
  expect((await learn.getSession(sessionId))?.session.status).toBe('paused')
  expect(await learn.continueSession(sessionId)).toMatchObject({ status: 'paused' })
  await library.setDeckArchived(deck.id, false)
  expect(await learn.continueSession(sessionId)).toMatchObject({
    status: 'active', currentAttempts: 1, currentLastSubmitted: 'restor', currentAssisted: true,
  })
  expect(await database.practice_events.count()).toBe(0)
})

test('preserves existing Learn history and repairs an exhausted cursor left by an earlier skip', async () => {
  const { words: [first], sessionId } = await start(['saved', 'removed'])
  await learn.recordAttempt(sessionId, first.term, true)
  await learn.finishCurrent(sessionId, 'completed')
  await database.learn_sessions.update(sessionId, { entryIds: [first.id], currentIndex: 1, status: 'paused' })
  const outbox = await database.client_outbox.toArray()
  const history = await database.practice_events.toArray()
  const progress = await database.learn_progress.toArray()
  database.close()
  await database.open()

  await learn.advanceInvalid(sessionId, undefined)
  expect(database.verno).toBe(5)
  expect(await learn.result(sessionId)).toMatchObject({
    session: { status: 'completed', currentIndex: 0 }, completed: 1, firstCompleted: 1,
  })
  expect(await database.client_outbox.toArray()).toEqual(outbox)
  expect(await database.practice_events.toArray()).toEqual(history)
  expect(await database.learn_progress.toArray()).toEqual(progress)
})

test('records assisted first submissions once and counts only unassisted first tries in results', async () => {
  const review = vi.spyOn(scheduler, 'createReviewScheduler')
  const { words: [first, second], sessionId } = await start(['answer', 'next'])
  const outboxCount = await database.client_outbox.count()
  expect(await learn.setAssisted(sessionId, first.id)).toBe(true)
  expect(await learn.setAssisted(sessionId, first.id)).toBe(false)
  expect(await database.client_outbox.count()).toBe(outboxCount)
  expect(await database.practice_events.count()).toBe(0)
  await Promise.all([1, 2].map(() => learn.recordAttempt(sessionId, first.term, true, Date.now(), first.id)))
  await Promise.all([1, 2].map(() => learn.finishCurrent(sessionId, 'completed', Date.now(), 0, first.id)))
  expect(await learn.setAssisted(sessionId, first.id)).toBe(false)
  expect((await learn.getSession(sessionId))?.session.currentAssisted).toBe(false)
  await learn.recordAttempt(sessionId, second.term, true)
  await learn.finishCurrent(sessionId, 'completed')
  expect(await learn.result(sessionId)).toMatchObject({ completed: 2, attempts: 2, firstTryCorrect: 1, assisted: 1 })
  const events = await database.practice_events.toArray()
  const ops = await database.client_outbox.toArray()
  expect(events).toHaveLength(2)
  expect(events.find(({ entryId }) => entryId === first.id)).toMatchObject({ firstTryCorrect: true, assisted: true })
  expect(ops).toHaveLength(outboxCount + 2)
  expect(review).not.toHaveBeenCalled()
  for (const event of events) {
    expect(ops).toContainEqual(expect.objectContaining({ kind: 'practice.create', payload: event }))
  }
})
