import { Rating, State } from 'ts-fsrs'
import { expect, test } from 'vitest'
import { REVIEW_DIRECTION, reviewRatings, type ReviewEvent, type ReviewRating } from '../domain/review'
import { createReviewScheduler, rebuildCardFromEvents, restoreCard, schedulerConfigSnapshot, schedulerGrades,
  serializeCard, serializeRevlog } from './scheduler'

test('initializes FSRS-7 and produces a scheduled card', async () => {
  const scheduler = await createReviewScheduler()
  const now = new Date('2026-01-01T09:00:00.000Z')
  const card = scheduler.newCard({ now })
  const { card: scheduled } = scheduler.review({ card, grade: Rating.Good, now })

  expect(scheduled.dueAt.getTime()).toBeGreaterThan(now.getTime())
  expect(scheduled.stabilityFast).toBeGreaterThan(0)
})

test('uses the v6 FSRS-7 defaults and maps the four business ratings to the official preview', async () => {
  const scheduler = await createReviewScheduler()
  const config = schedulerConfigSnapshot(scheduler)
  expect(config).toMatchObject({
    version: 'fsrs-7-v1', packageVersion: '6.0.0',
    options: {
      version: 'FSRS-7', desiredRetention: 0.9, enableFuzz: false, enableShortTerm: true,
      learningSteps: ['1m', '10m'], relearningSteps: ['10m'],
    },
  })
  const now = new Date('2026-01-01T09:00:00Z')
  const card = scheduler.newCard({ now, cardId: 'fixture' })
  expect(card).toMatchObject({ state: State.New, dueAt: now, lastReviewAt: null, stabilityFast: 0, reps: 0 })
  expect(restoreCard(serializeCard(card))).toEqual(card)
  const preview = [...scheduler.preview({ card, now })]
  expect(schedulerGrades).toEqual({ again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy })
  for (const rating of reviewRatings) {
    const grade = schedulerGrades[rating]
    const result = scheduler.review({ card, now, grade })
    expect(result.card).toEqual(preview.find((item) => item.grade === grade)?.card)
    expect(result.card.dueAt.getTime()).toBeGreaterThan(now.getTime())
    const stored = JSON.parse(JSON.stringify(serializeCard(result.card)))
    expect(stored.stabilityFast).toBeGreaterThan(0)
    expect(restoreCard(stored)).toEqual(result.card)
  }
  const again = preview.find(({ grade }) => grade === Rating.Again)!
  expect(again.card.dueAt.getTime() - now.getTime()).toBeLessThan(60 * 60 * 1000)
  expect(() => restoreCard({ ...serializeCard(again.card), dueAt: Number.NaN })).toThrow('timestamp')
  expect(() => restoreCard({ ...serializeCard(again.card), stabilityFast: Number.NaN })).toThrow('card state')
})

test('replays a single history in time and ID order using the recorded options', async () => {
  const scheduler = await createReviewScheduler({ version: 'FSRS-7', desiredRetention: 0.95, enableFuzz: false })
  const config = schedulerConfigSnapshot(scheduler)
  const cardId = 'fixture'
  const now = new Date('2026-01-01T09:00:00Z')
  const newCard = scheduler.newCard({ now, cardId })
  const rate = (id: string, rating: ReviewRating, card: typeof newCard, date: Date) => {
    const result = scheduler.review({ card, grade: schedulerGrades[rating], now: date })
    const event: ReviewEvent = {
      id, rating, cardId, entryId: 'word', deckId: 'deck', sessionId: id, direction: REVIEW_DIRECTION,
      reviewedAt: date.getTime(), schedulerModel: 'FSRS-7', schedulerConfigVersion: config.version,
      schedulerConfigSnapshot: config, resultingCardState: serializeCard(result.card),
      schedulerRevlog: serializeRevlog(result.revlog, rating),
    }
    return { event: Object.freeze(event), card: result.card }
  }
  const a = rate('a', 'again', newCard, now)
  const b = rate('b', 'hard', a.card, now)
  const c = rate('c', 'good', b.card, b.card.dueAt)
  const events = Object.freeze([c.event, b.event, a.event])
  expect(await rebuildCardFromEvents(events)).toEqual(serializeCard(c.card))
  expect(events.map(({ id }) => id)).toEqual(['c', 'b', 'a'])
  await expect(rebuildCardFromEvents([{ ...a.event, rating: 'manual' as ReviewRating }])).rejects.toThrow('rating')
})
