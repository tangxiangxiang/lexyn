import { expect, test, type Page } from '@playwright/test'
import type { OutboxOperation } from '../shared/contracts/library'
import type { ReviewCard, ReviewEvent, ReviewSession } from '../shared/domain/review'
import { createReviewScheduler, restoreCard, schedulerGrades } from '../shared/srs/scheduler'

const originTime = new Date('2026-10-01T12:00:00.000Z')

interface WordInput {
  term: string
  meaning: string
  example?: string
}

async function learnWords(page: Page, words: WordInput[]) {
  await page.goto('/library')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill('Review Systems')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name: 'Review Systems' }).click()
  const deckUrl = page.url()
  for (const { term, meaning, example } of words) {
    await page.getByRole('button', { name: 'Add word' }).click()
    await page.getByLabel('Term', { exact: true }).fill(term)
    await page.getByLabel('Meaning optional').fill(meaning)
    if (example) await page.getByLabel('Example optional').fill(example)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: term, exact: true })).toBeVisible()
  }
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: /Learn \d new word/ }).click()
  const pending = new Set(words.map(({ term }) => term))
  for (let index = 0; index < words.length; index++) {
    const heading = page.locator('.learn-term')
    await expect(heading).toBeVisible()
    const term = await heading.innerText()
    expect(pending.delete(term)).toBe(true)
    await page.getByRole('textbox', { name: 'Copy the word' }).fill(term)
    await page.getByRole('button', { name: 'Check spelling' }).click()
    await page.getByRole('button', { name: 'Next word' }).click()
    await expect(page.getByRole('heading', { name: term, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  return deckUrl
}

async function readReview(page: Page): Promise<{
  events: ReviewEvent[]
  cards: ReviewCard[]
  sessions: ReviewSession[]
  outbox: OutboxOperation[]
}> {
  return page.evaluate(async () => {
    const open = indexedDB.open('lexyn')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      const stores = ['review_events', 'review_cards', 'review_sessions', 'client_outbox']
      const transaction = database.transaction(stores, 'readonly')
      const [events, cards, sessions, outbox] = await Promise.all(stores.map((store) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })))
      return { events, cards, sessions, outbox } as Awaited<ReturnType<typeof readReview>>
    } finally {
      database.close()
    }
  })
}

async function openReview(page: Page) {
  await page.getByRole('link', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
}

function stat(page: Page, label: string) {
  return page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
}

test('learns from Library, restores a revealed answer and scores offline with real Progress data', async ({ page }) => {
  await page.clock.setFixedTime(originTime)
  const deckUrl = await learnWords(page, [{ term: 'concurrency', meaning: '并发（Concurrency）', example: 'Concurrency matters.' }])
  expect((await readReview(page)).events).toEqual([])
  await page.goto('/review?deckId=' + new URL(deckUrl).pathname.split('/').at(-1))
  await expect(stat(page, 'Waiting for first recall')).toHaveText('1')
  await expect(stat(page, 'Due reviews')).toHaveText('0')
  await page.getByRole('button', { name: 'Start review' }).click()
  const recall = page.locator('.review-recall')
  await expect(recall).toContainText('并发')
  expect(await recall.innerHTML()).not.toMatch(/concurrency/i)
  await expect(page.getByRole('button', { name: 'Good' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review paused' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Resume review' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency', exact: true })).toBeVisible()
  await page.context().setOffline(true)
  await page.getByRole('button', { name: 'Good' }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()

  const { events, cards, outbox, sessions } = await readReview(page)
  expect(events).toHaveLength(1)
  const event = events[0]
  expect(event).toMatchObject({ rating: 'good', reviewedAt: originTime.getTime(), schedulerModel: 'FSRS-7' })
  const scheduler = await createReviewScheduler()
  const expected = scheduler.review({
    card: scheduler.newCard({ now: originTime, cardId: event.cardId }), grade: schedulerGrades.good, now: originTime,
  }).card
  expect(cards).toHaveLength(1)
  // Node and Chromium can differ in the final floating-point digit while producing the same UTC due time.
  expect(restoreCard(cards[0].schedulerState)).toEqual({
    ...expected, scheduledDays: expect.closeTo(expected.scheduledDays, 12),
  })
  expect(sessions).toMatchObject([{ status: 'completed', currentIndex: 1 }])
  expect(outbox.filter(({ kind }) => kind === 'review.create')).toMatchObject([{ payload: event }])

  await page.getByRole('link', { name: 'Progress', exact: true }).click()
  await expect(stat(page, 'Learned for the first time today')).toHaveText('1')
  await expect(stat(page, 'Reviews rated today')).toHaveText('1')
  await expect(stat(page, 'Due reviews')).toHaveText('0')
  await expect(stat(page, 'Waiting for first recall')).toHaveText('0')
  await expect(page.locator('time')).toHaveAttribute('datetime', expected.dueAt.toISOString())

  await page.context().setOffline(false)
  await page.reload()
  await expect(stat(page, 'Reviews rated today')).toHaveText('1')
  await openReview(page)
  await expect(page.getByRole('button', { name: 'Start review' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Show answer' })).toHaveCount(0)
})

test('320px flip-card review becomes eligible at the SDK due time without a database change', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.clock.install({ time: originTime })
  await learnWords(page, [{ term: 'latch', meaning: '闩锁' }])
  await openReview(page)
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.getByText('闩锁', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.getByRole('heading', { name: 'latch' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await page.getByRole('button', { name: 'Again' }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const { events: [event] } = await readReview(page)
  const scheduler = await createReviewScheduler()
  const now = new Date(event.reviewedAt)
  const expected = scheduler.review({
    card: scheduler.newCard({ now, cardId: event.cardId }), grade: schedulerGrades.again, now,
  }).card.dueAt
  await expect(page.locator('time')).toHaveAttribute('datetime', expected.toISOString())
  await expect(stat(page, 'Due reviews')).toHaveText('0')
  await expect(page.getByRole('button', { name: 'Start review' })).toBeDisabled()
  const remaining = expected.getTime() - await page.evaluate(() => Date.now())
  expect(remaining).toBeGreaterThan(5000)
  await page.clock.fastForward(remaining + 5)
  await expect(stat(page, 'Due reviews')).toHaveText('1')
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.getByText('闩锁', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'latch' })).toHaveCount(0)
  expect((await readReview(page)).cards).toHaveLength(1)
})

test('manual ratings ignore spelling and block shortcuts in input, during IME, or on key repeat', async ({ page }) => {
  await learnWords(page, [{ term: 'deadlock', meaning: '死锁' }])
  await openReview(page)
  await page.getByRole('button', { name: 'Start review' }).click()
  const input = page.getByRole('textbox', { name: 'Type your recall' })
  const card = page.locator('.review-recall')
  await input.press('Space')
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await input.fill('a different valid expression')
  await card.focus()
  await card.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, isComposing: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, keyCode: 229 }))
  })
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.getByText('Your spelling differs.', { exact: false })).toBeVisible()
  await expect(card).toBeFocused()
  await card.dispatchEvent('keydown', { key: '4', isComposing: true })
  await card.dispatchEvent('keydown', { key: '4', repeat: true })
  await card.evaluate((element) => {
    const modal = document.createElement('dialog')
    document.body.append(modal)
    modal.showModal()
    element.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }))
    modal.close()
    modal.remove()
  })
  expect((await readReview(page)).events).toEqual([])
  await card.focus()
  await page.keyboard.down('4')
  await page.keyboard.down('4')
  await page.keyboard.up('4')
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  expect((await readReview(page)).events).toMatchObject([{ rating: 'easy' }])
})

test('outbox failure keeps the card for retry and removing the next word does not block the round', async ({ page }) => {
  const words = [{ term: 'cache', meaning: '缓存' }, { term: 'mutex', meaning: '互斥锁' }]
  const deckUrl = await learnWords(page, words)
  await openReview(page)
  await page.getByRole('button', { name: 'Start review' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  const currentTerm = await page.locator('.review-term').innerText()
  const outboxBefore = (await readReview(page)).outbox
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.name === 'client_outbox' && value?.kind === 'review.create') {
        IDBObjectStore.prototype.add = add
        throw new DOMException('Injected outbox failure', 'QuotaExceededError')
      }
      return add.call(this, value, key)
    }
  })
  await page.getByRole('button', { name: 'Hard' }).click()
  await expect(page.getByRole('alert')).toContainText('Review could not be saved')
  await expect(page.getByRole('heading', { name: currentTerm })).toBeVisible()
  expect(await readReview(page)).toMatchObject({
    events: [], cards: [], outbox: outboxBefore, sessions: [{ currentIndex: 0, currentRevealed: true }],
  })
  await page.getByRole('button', { name: 'Hard' }).dblclick()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()

  const removed = words.find(({ term }) => term !== currentTerm)!
  const library = await page.context().newPage()
  await library.goto(deckUrl)
  const article = library.getByRole('article').filter({ has: library.getByRole('heading', { name: removed.term, exact: true }) })
  await article.getByRole('button', { name: 'Remove word' }).click()
  await library.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await expect(article).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const data = await readReview(page)
  expect(data.events).toMatchObject([{ rating: 'hard' }])
  expect(data.cards).toHaveLength(1)
  expect(data.outbox.filter(({ kind }) => kind === 'review.create')).toHaveLength(1)
})
