import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, signIn, studyRequest, test, writeStudy } from './fixtures'
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
async function learn(page: Page, deck: string, entry: string) {
  const session = await write(page, 'learn/start', [deck, 'copy', [entry], true])
  await write(page, 'learn/attempt', [session.sessionId, entry, 'cache', session.revision])
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
    await expect(second.getByRole('heading', { name: 'cache', exact: true })).toBeVisible()
    const score = (target: Page, rating: string) => writeStudy(target, 'review/score',
      [round.sessionId, round.currentCardId, rating, round.revision])
    const results = await Promise.all([score(page, 'hard'), score(second, 'good')])
    expect(results.map((response) => response.status()).sort()).toEqual([200, 409])
    const history = await read(second, 'backup/library', [null])
    expect(history.reviewEvents).toHaveLength(1)
    expect(history.reviewCards).toHaveLength(1)
    expect(await rebuildCardFromEvents(history.reviewEvents)).toEqual(history.reviewCards[0].schedulerState)
    await second.reload()
    await expect(second.getByText('Rated today')).toBeVisible()
  } finally { await context.close() }
})

test('retries a committed Review response lost in transit using the same request key', async ({ page }) => {
  await revealed(page)
  await page.goto('/review')
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
