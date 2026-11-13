import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, openStudyLists, signIn, studyRequest, test, wordbookLink, writeStudy } from './fixtures'
import { rebuildCardFromEvents } from '../shared/srs/scheduler'

async function read(page: Page, path: string, args: unknown[] = []) {
  const response = await studyRequest(page, path, args)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data
}
async function write(page: Page, path: string, args: unknown[], key?: string) {
  const response = await writeStudy(page, path, args, key)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data
}
async function word(page: Page) {
  const deck = await write(page, 'library/create-deck', [{ name: 'Shared vocabulary' }])
  const entry = await write(page, 'library/create-entry', [deck.id, { term: 'cache', meaning: '缓存' }])
  return { deck, entry }
}
async function learn(page: Page, deck: string, entry: string, term = 'cache') {
  const session = await write(page, 'learn/start', [deck, 'copy', [entry], true])
  await write(page, 'learn/attempt', [session.sessionId, entry, term, session.revision])
  return (await read(page, 'learn/session', [session.sessionId])).session
}
async function revealed(page: Page) {
  const { deck, entry } = await word(page)
  const session = await learn(page, deck.id, entry.id)
  await write(page, 'learn/finish', [session.sessionId, entry.id, 'completed', session.revision])
  await write(page, 'review/start', [deck.id])
  const { session: round } = await read(page, 'review/session', [deck.id])
  await write(page, 'review/reveal', [round.sessionId, round.currentCardId, entry.revision, round.revision])
  return (await read(page, 'review/session', [deck.id])).session
}

test('two devices resume the same Review session and competing ratings commit once', async ({ page, browser, baseURL }) => {
  const round = await revealed(page)
  const context = await browser.newContext({ baseURL })
  try {
    const second = await context.newPage()
    await second.goto('/review')
    await signIn(second)
    await second.getByRole('button', { name: 'Continue existing session' }).click()
    await expect(second.getByRole('heading', { name: 'cache', exact: true })).toBeVisible()
    const score = (target: Page, rating: string) => writeStudy(target, 'review/score',
      [round.sessionId, round.currentCardId, rating, round.revision])
    const results = await Promise.all([score(page, 'hard'), score(second, 'good')])
    expect(results.map((response) => response.status()).sort()).toEqual([200, 409])
    const history = await read(second, 'backup/library', [null])
    expect(history.reviewEvents).toHaveLength(1)
    expect(history.reviewCards).toHaveLength(1)
    expect(await rebuildCardFromEvents(history.reviewEvents)).toEqual(history.reviewCards[0].schedulerState)
    expect(await read(page, 'progress/overview')).toMatchObject({ learnedTotal: 1, ratedToday: 1, reviewedWordsToday: 1 })
    await second.reload()
    await expect(second.getByText('Rated today')).toBeVisible()
  } finally { await context.close() }
})

test('retries a committed Review response lost in transit using the same request key', async ({ page }) => {
  await revealed(page)
  await page.goto('/review?deckId=' + (await read(page, 'review/open')).deckId)
  const keys: (string | undefined)[] = []
  await page.route('**/api/review/score', async (route) => {
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length === 1) {
      const response = await route.fetch()
      expect(response.ok()).toBeTruthy()
      await route.abort()
    } else await route.continue()
  })
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  await expect(page.locator('.review-page').getByRole('alert')).toContainText('Could not reach the server')
  await expect(page.getByRole('heading', { name: 'cache', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  expect(keys).toEqual([expect.any(String), keys[0]])
  expect((await read(page, 'backup/library', [null])).reviewEvents).toHaveLength(1)
})

test('two devices resume Learn and retry one finish without incrementing quota twice', async ({ page, browser, baseURL }) => {
  const { deck, entry } = await word(page)
  await write(page, 'settings/daily', [1])
  const session = await learn(page, deck.id, entry.id)
  const context = await browser.newContext({ baseURL })
  try {
    const other = await context.newPage()
    await other.goto('/learn')
    await signIn(other)
    const resume = await read(other, 'learn/daily', [deck.id])
    expect(resume.activeSession).toMatchObject({ sessionId: session.sessionId, currentAttempts: 1 })
    const key = randomUUID()
    const args = [session.sessionId, entry.id, 'completed', session.revision]
    const first = await write(page, 'learn/finish', args, key)
    expect(await write(other, 'learn/finish', args, key)).toEqual(first)
    expect((await writeStudy(other, 'learn/finish', args)).status()).toBe(409)
    const history = await read(other, 'backup/library', [null])
    expect(history.practiceEvents).toHaveLength(1)
    expect(history.learnProgress[0].completedCount).toBe(1)
    expect(history.reviewEvents).toEqual([])
    expect(await read(other, 'learn/daily', [deck.id])).toMatchObject({ quota: 1, completedToday: 1, candidates: [] })
  } finally { await context.close() }
})

test('rejects a stale Library edit and hides personal state after signing out', async ({ page, browser, baseURL }) => {
  const { deck, entry } = await word(page)
  const context = await browser.newContext({ baseURL })
  try {
    const other = await context.newPage()
    await other.goto('/library')
    await signIn(other)
    await expect(other.getByRole('link', { name: deck.name })).toBeVisible()
    const edit = (term: string) => [deck.id, entry.id, { term, meaning: '缓存' }, entry.revision]
    await write(page, 'library/update-entry', edit('cache memory'))
    expect((await writeStudy(other, 'library/update-entry', edit('stale change'))).status()).toBe(409)
    await other.goto(new URL('/settings', other.url()).href)
    await other.getByRole('link', { name: /Owner account/ }).click()
    await other.getByRole('button', { name: 'Sign out' }).click()
    await expect(other.getByLabel('Owner password')).toBeVisible()
    await expect(other.getByRole('navigation')).toHaveCount(0)
    const response = await other.request.get('/api/library/decks', { headers: { 'X-Lexyn-Client': '1' } })
    expect(response.status()).toBe(401)
  } finally { await context.close() }
})

test('All starts review from the dial, restores it, and advances to new learning without a second Start', async ({ page, backend }) => {
  const { deck, entry } = await word(page)
  const finished = await learn(page, deck.id, entry.id)
  await write(page, 'learn/finish', [finished.sessionId, entry.id, 'completed', finished.revision])
  await write(page, 'library/create-entry', [deck.id, { term: 'buffer', meaning: '缓冲区' }])
  await page.reload()
  await wordbookLink(page, deck.name).click()
  await page.goto('/study')

  const dial = page.locator('.spell-ring-label')
  await expect(dial).toContainText('Words to learn')
  await dial.click()
  await expect(dial).toHaveAttribute('aria-pressed', 'true')
  await expect(dial).toHaveText('2Words to study')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('缓存', { exact: true })).toBeVisible()
  const reviewUrl = new URL(page.url())
  const flow = reviewUrl.searchParams.get('flow')
  expect(flow).toBeTruthy()
  const scoped = await read(page, 'review/scoped', [deck.id, reviewUrl.searchParams.get('session')])
  expect(scoped.word).toEqual({ prompt: '缓存', entryRevision: 1, card: false })
  await expect(page.locator('.review-recall')).not.toContainText('cache')
  await expect(page.getByRole('button', { name: 'Play pronunciation' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Spell the word' }).click()
  const keyboard = page.getByRole('group', { name: 'On-screen keyboard' })
  await expect(keyboard.locator('button').filter({ hasText: /^[a-z]$/ })).toHaveCount(26)
  await keyboard.getByRole('button', { name: 'c', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Type your recall' })
  await expect(input).toHaveValue('c')
  await expect(page.getByRole('group', { name: 'Your spelling so far' })).toHaveText('c')
  await input.pressSequentially('ache')
  await expect(input).toHaveValue('cache')
  await expect(page.getByRole('group', { name: 'Recall ratings' })).toHaveCount(0)
  await input.press('Enter')
  await expect(page.getByText('Your spelling matches.', { exact: false })).toBeVisible()
  const count = (table: string) => backend.db.prepare('SELECT count(*) FROM ' + table).pluck().get()
  expect(count('review_events')).toBe(0)
  expect(count('practice_events')).toBe(1)
  await page.getByLabel('Session options', { exact: true }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review paused' })).toBeVisible()
  await page.goto('/study')
  await dial.click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'cache', exact: true })).toBeVisible()
  expect(page.url()).toBe(reviewUrl.href)

  await page.getByRole('button', { name: 'Good', exact: true }).click()
  await expect(page).toHaveURL(/\/learn\/read\?/)
  expect(new URL(page.url()).searchParams.get('flow')).toBe(flow)
  await page.getByRole('link', { name: 'Start spelling' }).click()
  await page.getByRole('textbox', { name: 'Copy the word' }).fill('buffer')
  await expect(page).toHaveURL(/\/study\/all\?/)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  const summary = page.locator('.study-result-grid')
  await expect(summary.locator('div').filter({ hasText: 'Cards rated' }).locator('strong')).toHaveText('1')
  await expect(summary.locator('div').filter({ hasText: 'New words learned' }).locator('strong')).toHaveText('1')
  await expect(page.getByText('1 study item remaining.')).toBeVisible()
  await page.reload()
  await expect(summary.locator('div').filter({ hasText: 'New words learned' }).locator('strong')).toHaveText('1')
  expect(count('review_events')).toBe(1)
  expect(count('review_cards')).toBe(1)
  expect(count('practice_events')).toBe(2)
})

test('the Review dial explains a conflicting round and one Start resumes the selected scope after ending it', async ({ page, backend }) => {
  const previous = await revealed(page)
  await write(page, 'review/status', [previous.sessionId, 'paused', previous.revision])
  const book = await write(page, 'library/create-deck', [{ name: 'Current vocabulary' }])
  const entry = await write(page, 'library/create-entry', [book.id, { term: 'buffer', meaning: '缓冲区' }])
  const finished = await learn(page, book.id, entry.id, 'buffer')
  await write(page, 'learn/finish', [finished.sessionId, entry.id, 'completed', finished.revision])
  await page.reload()
  await wordbookLink(page, book.name).click()
  await page.goto('/study')
  await page.getByRole('button', { name: 'Words to review 1' }).press('Enter')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Another review round is open' })).toBeVisible()
  expect((await read(page, 'review/open')).status).toBe('paused')
  await page.getByRole('button', { name: 'End existing session and start' }).click()
  await expect(page.getByText('缓冲区', { exact: true })).toBeVisible()
  const current = await read(page, 'review/open')
  expect(current).toMatchObject({ deckId: book.id, status: 'active' })
  expect((await read(page, 'review/scoped', [previous.deckId, previous.sessionId])).session.status).toBe('abandoned')

  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByLabel('Session options', { exact: true }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review paused' })).toBeVisible()
  await page.goto('/study')
  await page.getByRole('button', { name: 'Words to review 1' }).press('Enter')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'buffer', exact: true })).toBeVisible()
  expect((await read(page, 'review/open')).sessionId).toBe(current.sessionId)
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
})

test('shares a learned word and one FSRS chain across books while keeping each local prompt', async ({ page, backend }) => {
  backend.advanceTo(Date.UTC(2026, 9, 2, 12))
  const a = await write(page, 'library/create-deck', [{ name: 'CET4' }])
  const appleA = await write(page, 'library/create-entry', [a.id, { term: 'apple', meaning: '苹果' }])
  await page.reload()
  await openStudyLists(page, 'CET4')
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 1 new word' }).click()
  await page.getByRole('link', { name: 'Start spelling' }).click()
  await page.getByRole('textbox', { name: 'Copy the word' }).fill('apple')
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start review' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: 'Again', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const initial = (await read(page, 'backup/library', [null])).reviewCards[0]

  const b = await write(page, 'library/create-deck', [{ name: 'IELTS' }])
  const appleB = await write(page, 'library/create-entry', [b.id, { term: 'Apple', meaning: '苹果公司' }])
  expect(appleB.wordId).toBe(appleA.wordId)
  expect(appleB.id).not.toBe(appleA.id)
  expect(await read(page, 'learn/daily', [b.id])).toMatchObject({ pendingNew: 0, completedToday: 1, candidates: [] })
  expect(await read(page, 'library/word-detail', [b.id, appleB.id])).toMatchObject({
    nextDueAt: initial.dueAt, spelling: { attempts: 1, firstTryCorrectRate: 1 },
  })
  backend.advanceTo(initial.dueAt + 1000)
  expect(await read(page, 'progress/overview')).toMatchObject({
    due: 1, firstRecall: 0, learnedTotal: 1,
    deckStats: expect.arrayContaining([{ deckId: a.id, due: 1 }, { deckId: b.id, due: 1 }]),
  })
  await page.goto('/library')
  await openStudyLists(page, 'IELTS')
  await expect(page.getByRole('link', { name: 'Practice this list' })).toBeVisible()
  await page.getByRole('link', { name: 'Review this list' }).click()
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.getByText('苹果公司', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Apple', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
  const history = await read(page, 'backup/library', [null])
  expect(history.reviewCards).toMatchObject([{ id: initial.id, revision: 2 }])
  expect(history.wordCards).toEqual([{ wordId: appleA.wordId, cardId: initial.id, direction: 'meaning-to-term', active: true }])
  expect(history.reviewEvents).toMatchObject([
    { entryId: appleA.id, deckId: a.id, cardId: initial.id },
    { entryId: appleB.id, deckId: b.id, cardId: initial.id },
  ])
  expect(await rebuildCardFromEvents(history.reviewEvents)).toEqual(history.reviewCards[0].schedulerState)
  expect(await read(page, 'progress/overview')).toMatchObject({ learnedTotal: 1, ratedToday: 2, reviewedWordsToday: 1 })
  expect(await read(page, 'library/word-detail', [a.id, appleA.id])).toMatchObject({ nextDueAt: history.reviewCards[0].dueAt })
  const deckBackup = await read(page, 'backup/library', [b.id])
  expect(deckBackup).toMatchObject({ decks: [{ id: b.id }], words: [{ id: appleA.wordId }], reviewCards: [], reviewEvents: [] })

  await write(page, 'library/remove-entry', [a.id, appleA.id, true, appleA.revision])
  await write(page, 'library/archive-deck', [b.id, true, b.revision])
  backend.advanceTo(history.reviewCards[0].dueAt + 1000)
  expect(await read(page, 'review/overview', [null])).toMatchObject({ due: 0 })
  await write(page, 'library/archive-deck', [b.id, false, b.revision + 1])
  expect(await read(page, 'review/overview', [null])).toMatchObject({ due: 1 })
  await write(page, 'library/remove-entry', [a.id, appleA.id, false, appleA.revision + 1])
  expect(await read(page, 'review/overview', [null])).toMatchObject({ due: 1 })
  expect((await read(page, 'backup/library', [null])).reviewCards).toEqual(history.reviewCards)
})
