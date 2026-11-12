import type { Page } from '@playwright/test'
import { navigateFromMenu, expect, libraryAction, test, writeStudy } from './fixtures'
import type Database from 'better-sqlite3'
import type { ReviewCard, ReviewEvent, ReviewSession } from '../shared/domain/review'
import { createReviewScheduler, rebuildCardFromEvents, restoreCard, schedulerGrades } from '../shared/srs/scheduler'
import { trackPlayback } from './mock-speech'

const originTime = new Date('2026-10-01T12:00:00.000Z')

interface WordInput {
  term: string
  meaning: string
  explanation?: string
  example?: string
  fullDefinition?: string
  phonetic?: string
}

async function learnWords(page: Page, words: WordInput[]) {
  await page.goto('/library')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill('Review Systems')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name: 'Review Systems' }).click()
  const deckUrl = page.url()
  const deckId = new URL(deckUrl).pathname.split('/').at(-1)!
  for (const { term, meaning, explanation, example, fullDefinition, phonetic } of words) {
    const definitions = [meaning, ...(fullDefinition ? [fullDefinition] : [])]
    const response = await writeStudy(page, 'library/create-entry', [deckId, {
      term, meaning, phonetic, dictionaryMeaning: { senses: [{ partOfSpeech: 'n.', definitions, source: 'manual' }] },
      ...(explanation ? { explanation } : {}), ...(example ? { example } : {}),
    }])
    expect(response.ok()).toBe(true)
  }
  await page.goto(deckUrl)
  for (const { term } of words) await expect(page.getByRole('heading', { name: term, exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: /Learn \d new word/ }).click()
  await page.getByRole('link', { name: 'Start spelling' }).click()
  const pending = new Set(words.map(({ term }) => term))
  for (let index = 0; index < words.length; index++) {
    const heading = page.locator('.learn-card').getByRole('heading')
    await expect(heading).toBeVisible()
    const term = (await heading.textContent())!.trim()
    expect(pending.delete(term)).toBe(true)
    const current = words.find((word) => word.term === term)
    const definition = current?.fullDefinition
    if (definition) await expect(page.locator('.learn-card .dictionary-definition')).toContainText([current!.meaning, definition])
    if (current?.phonetic) {
      await expect(page.getByRole('button', { name: `Play pronunciation ${current.phonetic}` })).toHaveText(current.phonetic)
    }
    await page.getByRole('textbox', { name: 'Copy the word' }).fill(term)
    await expect(page.getByRole('heading', { name: term, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  return deckUrl
}

function readReview(db: Database.Database) {
  const read = <T>(table: string): T[] =>
    (db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[]).map(({ body }) => JSON.parse(body))
  return { events: read<ReviewEvent>('review_events'), cards: read<ReviewCard>('review_cards'),
    sessions: read<ReviewSession>('review_sessions') }
}

async function openReview(page: Page) {
  await navigateFromMenu(page, 'Review')
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
}

function stat(page: Page, label: string) {
  return page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
}

test('fills missing IPA in a rated word without changing its meaning or FSRS schedule', async ({ page, backend }) => {
  const deckUrl = await learnWords(page, [{ term: 'command', meaning: '命令', fullDefinition: '指令', phonetic: '/kəˈmɑːnd/' }])
  await openReview(page)
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.locator('.phonetics')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.locator('.phonetics')).toHaveText('/kəˈmɑːnd/')
  await page.getByRole('button', { name: 'Good' }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const before = readReview(backend.db)
  expect(before.cards).toHaveLength(1)
  const entryBody = () => JSON.parse(backend.db.prepare("SELECT body FROM entries WHERE active_term = 'command'").pluck().get() as string)
  const entry = entryBody()
  await page.goto(deckUrl)
  await expect(page.locator('.phonetics')).toHaveText('/kəˈmɑːnd/')

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  backend.vocabulary.beforeReply = () => gate
  try {
    await page.getByRole('button', { name: 'Search and filters' }).click()
    await page.getByRole('button', { name: 'AI fill missing IPA' }).click()
    await page.getByRole('button', { name: 'Fill missing IPA (1)' }).click()
    await expect.poll(() => backend.vocabulary.requests).toEqual([['command']])
    await page.reload()
    await page.getByRole('button', { name: 'Search and filters' }).click()
    await page.getByRole('button', { name: 'View AI task progress' }).click()
    await expect(page.getByRole('heading', { name: 'AI fill missing IPA', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop AI task' }).click()
    await expect(page.getByText('AI vocabulary task stopped')).toBeVisible()
    expect(entryBody()).toEqual(entry)
  } finally {
    backend.vocabulary.beforeReply = undefined
    release()
  }
  await expect.poll(() => backend.vocabulary.responses.length).toBe(1)
  await page.getByRole('button', { name: 'Retry IPA backfill (1)' }).click()
  await expect(page.getByText('AI vocabulary task completed')).toBeVisible()
  await expect(page.getByText('No words need IPA.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.phonetics span')).toHaveText(['UK /kəˈmɑːnd/', 'US /kəˈmænd/'])
  expect(entryBody()).toMatchObject({ meaning: entry.meaning, dictionaryMeaning: entry.dictionaryMeaning,
    phonetic: entry.phonetic, phonetics: { british: 'kəˈmɑːnd', american: 'kəˈmænd' } })
  expect(readReview(backend.db)).toEqual(before)
})

test('learns from Library, restores a revealed answer and scores on the server with real Progress data', async ({ page, backend }) => {
  await trackPlayback(page)
  backend.advanceTo(originTime.getTime())
  await page.clock.setFixedTime(originTime)
  const deckUrl = await learnWords(page, [{ term: 'concurrency', meaning: '并发',
    explanation: '多个任务在重叠的时间段内推进。', example: 'Concurrency matters.', fullDefinition: '并行性'  }])
  expect(readReview(backend.db).events).toEqual([])
  await page.goto('/review?deckId=' + new URL(deckUrl).pathname.split('/').at(-1))
  await expect(stat(page, 'Waiting for first recall')).toHaveText('1')
  await expect(stat(page, 'Due reviews')).toHaveText('0')
  await page.getByRole('button', { name: 'Start review' }).click()
  const recall = page.locator('.review-recall')
  await expect(recall).toContainText('并发')
  await expect(page.locator('.dictionary-definition')).toHaveCount(0)
  await expect(page.getByText('多个任务在重叠的时间段内推进。')).toHaveCount(0)
  expect(await recall.innerHTML()).not.toMatch(/concurrency/i)
  await expect(page.getByRole('button', { name: 'Good' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play pronunciation' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.locator('.dictionary-definition')).toHaveText(['并发', '并行性'])
  await expect(page.getByText('多个任务在重叠的时间段内推进。')).toHaveCount(0)
  await expect(page.getByText('Concurrency matters.')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'concurrency', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Play pronunciation' }).click()
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  expect(readReview(backend.db).events).toEqual([])

  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review paused' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Resume review' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency', exact: true })).toBeVisible()
  await page.route('**/api/speech/audio/*', (route) => route.abort())
  await page.getByRole('button', { name: 'Play pronunciation' }).click()
  await expect(page.getByText('Could not reach the server.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Good' }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()

  const { events, cards, sessions } = readReview(backend.db)
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
  const entry = JSON.parse(backend.db.prepare('SELECT body FROM entries').pluck().get() as string)
  expect((await writeStudy(page, 'library/update-entry', [entry.deckId, entry.id, {
    term: entry.term, meaning: entry.meaning,
    dictionaryMeaning: { senses: [{ partOfSpeech: 'n.', definitions: ['并行执行'], source: 'manual' }] },
  }, entry.revision])).ok()).toBe(true)
  expect(readReview(backend.db)).toEqual({ events, cards, sessions })
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(1)

  await navigateFromMenu(page, 'Progress')
  await expect(stat(page, 'Learned for the first time today')).toHaveText('1')
  await expect(stat(page, 'Reviews rated today')).toHaveText('1')
  await expect(stat(page, 'Due reviews')).toHaveText('0')
  await expect(stat(page, 'Waiting for first recall')).toHaveText('0')
  await expect(page.locator('time')).toHaveAttribute('datetime', expected.dueAt.toISOString())

  await page.reload()
  await expect(stat(page, 'Reviews rated today')).toHaveText('1')
  await openReview(page)
  await expect(page.getByRole('button', { name: 'Start review' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Show answer' })).toHaveCount(0)
})

test('320px flip-card review becomes eligible at the SDK due time without a database change', async ({ page, backend }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  backend.advanceTo(originTime.getTime())
  await page.clock.install({ time: originTime })
  await learnWords(page, [{ term: 'latch', meaning: '闩锁' }])
  await openReview(page)
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.locator('.review-meaning')).toContainText('闩锁')
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.getByRole('heading', { name: 'latch' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await page.getByRole('button', { name: 'Again' }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const { events: [event] } = readReview(backend.db)
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
  backend.advanceTo(expected.getTime() + 5)
  await page.clock.fastForward(remaining + 1005)
  await expect(stat(page, 'Due reviews')).toHaveText('1')
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.locator('.review-meaning')).toContainText('闩锁')
  await expect(page.getByRole('heading', { name: 'latch' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const { cards, events } = readReview(backend.db)
  expect(cards).toMatchObject([{ id: event.cardId, revision: 2 }])
  expect(events.map(({ rating }) => rating)).toEqual(['again', 'good'])
  expect(await rebuildCardFromEvents(events)).toEqual(cards[0].schedulerState)
})

test('manual ratings ignore spelling and block shortcuts in input, during IME, or on key repeat', async ({ page, backend }) => {
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
  expect(readReview(backend.db).events).toEqual([])
  await card.focus()
  await page.keyboard.down('4')
  await page.keyboard.down('4')
  await page.keyboard.up('4')
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  expect(readReview(backend.db).events).toMatchObject([{ rating: 'easy' }])
})

test('network failure keeps the card for retry and removing the next word does not block the round', async ({ page, backend }) => {
  const words = [{ term: 'cache', meaning: '缓存' }, { term: 'mutex', meaning: '互斥锁' }]
  const deckUrl = await learnWords(page, words)
  await openReview(page)
  await page.getByRole('button', { name: 'Start review' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  const currentTerm = await page.locator('.review-term').innerText()
  await page.route('**/api/review/score', (route) => route.abort(), { times: 1 })
  await page.getByRole('button', { name: 'Hard' }).click()
  await expect(page.locator('.review-page').getByRole('alert')).toContainText('Could not reach the server')
  await expect(page.getByRole('heading', { name: currentTerm })).toBeVisible()
  expect(readReview(backend.db)).toMatchObject({
    events: [], cards: [], sessions: [{ currentIndex: 0, currentRevealed: true }],
  })
  await page.getByRole('button', { name: 'Hard' }).dblclick()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()

  const removed = words.find(({ term }) => term !== currentTerm)!
  const library = await page.context().newPage()
  await library.goto(deckUrl)
  const article = library.getByRole('article').filter({ has: library.getByRole('heading', { name: removed.term, exact: true }) })
  await libraryAction(article, 'Remove word')
  await library.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await expect(article).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const data = readReview(backend.db)
  expect(data.events).toMatchObject([{ rating: 'hard' }])
  expect(data.cards).toHaveLength(1)
})
