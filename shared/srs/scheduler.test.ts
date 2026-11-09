import { Rating } from 'ts-fsrs'
import { expect, test } from 'vitest'
import { createReviewScheduler } from './scheduler'

test('initializes FSRS-7 and produces a scheduled card', async () => {
  const scheduler = await createReviewScheduler()
  const now = new Date('2026-01-01T09:00:00.000Z')
  const card = scheduler.newCard({ now })
  const { card: scheduled } = scheduler.review({ card, grade: Rating.Good, now })

  expect(scheduled.dueAt.getTime()).toBeGreaterThan(now.getTime())
  expect(scheduled.stabilityFast).toBeGreaterThan(0)
})
