import { expect, test, type Browser, type Page } from '@playwright/test'
import type { OutboxOperation } from '../shared/contracts/library'
import type { PushRequest } from '../shared/contracts/sync'
import type { LearnProgress } from '../shared/domain/learning'
import type { ReviewCard, ReviewEvent } from '../shared/domain/review'
import { rebuildCardFromEvents } from '../shared/srs/scheduler'
import type { SyncState } from '../src/features/sync/types'

const password = () => process.env.LEXYN_TEST_OWNER_PASSWORD!

async function device(browser: Browser, baseURL: string | undefined, mobile = false) {
  const context = await browser.newContext({ baseURL, viewport: mobile ? { width: 320, height: 740 } : undefined })
  return { context, page: await context.newPage() }
}

async function settings(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('region', { name: 'Synchronization' })).toBeVisible()
}

async function signIn(page: Page) {
  await page.getByLabel('Owner password').fill(password())
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Signed in as Owner')).toBeVisible()
  await waitSynced(page)
}

async function waitSynced(page: Page) {
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
  await expect(page.getByText('0 pending operations', { exact: true })).toBeVisible()
}

async function syncNow(page: Page) {
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sync/pull' && response.ok()),
    page.getByRole('button', { name: 'Sync now' }).click(),
  ])
  await waitSynced(page)
}

async function createDeck(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click()
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).click()
  const path = new URL(page.url()).pathname
  return { path, id: path.split('/').at(-1)! }
}

async function addWord(page: Page, term: string, meaning: string) {
  await page.getByRole('button', { name: 'Add word' }).click()
  await page.getByLabel('Term', { exact: true }).fill(term)
  await page.getByLabel('Meaning optional').fill(meaning)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: term, exact: true })).toBeVisible()
}

async function editWord(page: Page, meaning: string) {
  await page.getByRole('button', { name: 'Edit word' }).click()
  await page.getByLabel('Meaning optional').fill(meaning)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(meaning, { exact: true })).toBeVisible()
}

async function learnWord(page: Page, term: string) {
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 1 new word' }).click()
  await page.getByRole('textbox', { name: 'Copy the word' }).fill(term)
  await page.getByRole('button', { name: 'Check spelling' }).click()
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
}

async function rate(page: Page, rating: string) {
  await page.getByRole('button', { name: 'Start review' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: rating, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
}

interface Stores {
  client_outbox: (OutboxOperation & { operationId: string })[]
  learn_progress: LearnProgress[]
  review_cards: ReviewCard[]
  review_events: ReviewEvent[]
  sync_state: SyncState[]
}

async function records<K extends keyof Stores>(page: Page, store: K): Promise<Stores[K]> {
  return page.evaluate(async (table) => {
    const request = indexedDB.open('lexyn')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const read = database.transaction(table, 'readonly').objectStore(table).getAll()
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      })
    } finally { database.close() }
  }, store)
}

for (const reverse of [false, true]) {
  test(`two devices retain both offline ratings and converge (${reverse ? 'phone' : 'desktop'} pushes first)`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000)
    const a = await device(browser, baseURL)
    const b = await device(browser, baseURL, true)
    try {
      const time = Date.now() - 86_400_000
      await a.page.clock.setFixedTime(time)
      await b.page.clock.setFixedTime(time)
      await a.page.goto('/library')
      const { id, path } = await createDeck(a.page, reverse ? 'Phone first systems' : 'Desktop first systems')
      await addWord(a.page, 'concurrency', '并发')
      await learnWord(a.page, 'concurrency')
      const legacy = (await records(a.page, 'client_outbox')).sort((left, right) => left.sequence - right.sequence)
      expect(legacy.map(({ kind }) => kind)).toEqual(['deck.create', 'entry.create', 'practice.create'])
      await settings(a.page)
      await signIn(a.page)

      await b.page.goto('/settings')
      await signIn(b.page)
      expect(await b.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
      expect((await records(a.page, 'sync_state'))[0].deviceId).not.toBe((await records(b.page, 'sync_state'))[0].deviceId)
      await b.page.goto(path)
      await expect(b.page.getByRole('heading', { name: 'concurrency', exact: true })).toBeVisible()
      const word = legacy[1].payload.id
      expect((await records(b.page, 'learn_progress')).find(({ entryId }) => entryId === word))
        .toMatchObject({ firstCompletedAt: time, completedCount: 1 })

      const reviewUrl = '/review?deckId=' + id
      await b.page.goto(reviewUrl)
      await expect(b.page.getByText('Waiting for first recall', { exact: true })).toBeVisible()
      await rate(b.page, 'Again')
      await settings(b.page)
      await syncNow(b.page)
      await syncNow(a.page)
      const [initial] = (await records(a.page, 'review_cards')).filter(({ entryId }) => entryId === word)
      expect(initial.schedulerState.stabilityFast).toBeGreaterThan(0)
      await a.page.clock.setFixedTime(initial.dueAt + 1)
      await b.page.clock.setFixedTime(initial.dueAt + 2)
      await a.page.goto(reviewUrl)
      await b.page.goto(reviewUrl)
      await expect(a.page.getByRole('button', { name: 'Start review' })).toBeEnabled()
      await expect(b.page.getByRole('button', { name: 'Start review' })).toBeEnabled()
      await Promise.all([a.context.setOffline(true), b.context.setOffline(true)])
      await Promise.all([rate(a.page, 'Good'), rate(b.page, 'Again')])
      const [aPending, bPending] = await Promise.all([records(a.page, 'client_outbox'), records(b.page, 'client_outbox')])
      expect(aPending).toHaveLength(1)
      expect(bPending).toHaveLength(1)
      const aEvent = aPending[0].payload as ReviewEvent
      const bEvent = bPending[0].payload as ReviewEvent
      expect(aEvent.id).not.toBe(bEvent.id)
      expect(aPending[0].opId).not.toBe(aEvent.id)
      await settings(a.page)
      await settings(b.page)
      const [first, second] = reverse ? [b, a] : [a, b]

      if (!reverse) {
        let dropped = false
        let allowRetry = false
        await first.page.route('**/api/sync/push', async (route) => {
          const body = route.request().postDataJSON() as PushRequest
          if (!body.operations.some(({ kind }) => kind === 'review.create') || allowRetry) return route.continue()
          if (dropped) return route.fulfill({ status: 500, json: { error: { message: 'Injected retry outage' } } })
          const response = await route.fetch()
          expect(response.ok()).toBe(true)
          expect(await response.json()).toMatchObject({ results: [{ status: 'accepted' }] })
          dropped = true
          await route.abort('failed')
        })
        await first.context.setOffline(false)
        await expect.poll(() => dropped).toBe(true)
        expect(await records(first.page, 'client_outbox')).toMatchObject([{ operationId: aPending[0].opId }])
        allowRetry = true
        await syncNow(first.page)
      } else {
        await first.context.setOffline(false)
        await syncNow(first.page)
      }
      expect(await records(second.page, 'client_outbox')).toHaveLength(1)
      await second.context.setOffline(false)
      await syncNow(second.page)
      await syncNow(first.page)

      const [ae, be] = await Promise.all([records(a.page, 'review_events'), records(b.page, 'review_events')])
      const events = ae.filter(({ entryId }) => entryId === word)
      expect(events).toEqual(be.filter(({ entryId }) => entryId === word))
      expect(events).toHaveLength(3)
      expect(events.find(({ id }) => id === aEvent.id)).toMatchObject({ ...aEvent, rating: 'good' })
      expect(events.find(({ id }) => id === bEvent.id)).toMatchObject({ ...bEvent, rating: 'again' })
      const ac = (await records(a.page, 'review_cards')).find(({ entryId }) => entryId === word)!
      const bc = (await records(b.page, 'review_cards')).find(({ entryId }) => entryId === word)!
      expect(ac).toEqual(bc)
      expect(ac.dueAt).toBe(bc.dueAt)
      expect(ac.schedulerState).toEqual(await rebuildCardFromEvents(events))
      expect(ac.revision).toBe(3)
      expect(await records(a.page, 'client_outbox')).toHaveLength(0)
      expect(await records(b.page, 'client_outbox')).toHaveLength(0)

      if (!reverse) {
        await a.page.getByRole('button', { name: 'Sign out' }).click()
        await expect(a.page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
        const deviceId = (await records(a.page, 'sync_state'))[0].deviceId
        await a.page.goto(path)
        await addWord(a.page, 'mutex', '互斥锁')
        expect(await records(a.page, 'client_outbox')).toHaveLength(1)
        await settings(a.page)
        await signIn(a.page)
        expect((await records(a.page, 'sync_state'))[0].deviceId).toBe(deviceId)
        await syncNow(b.page)
        await b.page.goto(path)
        await expect(b.page.getByRole('heading', { name: 'mutex', exact: true })).toBeVisible()
      }
    } finally {
      await Promise.all([a.context.close(), b.context.close()])
    }
  })
}

test('shows both sides of an edit conflict and retries a failed pull without advancing the cursor', async ({ browser, baseURL }) => {
  test.setTimeout(90_000)
  const a = await device(browser, baseURL)
  const b = await device(browser, baseURL, true)
  try {
    await a.page.goto('/settings')
    await signIn(a.page)
    await b.page.goto('/settings')
    await signIn(b.page)
    const { path } = await createDeck(a.page, 'Conflict systems')
    await addWord(a.page, 'deadlock', '原释义')
    await settings(a.page)
    await syncNow(a.page)
    await syncNow(b.page)
    await a.page.goto(path)
    await b.page.goto(path)
    await Promise.all([a.context.setOffline(true), b.context.setOffline(true)])
    await editWord(a.page, '死锁')
    await editWord(b.page, '死锁状态')
    await settings(a.page)
    await settings(b.page)
    await a.context.setOffline(false)
    await syncNow(a.page)
    await b.context.setOffline(false)
    await b.page.getByRole('button', { name: 'Sync now' }).click()
    const issues = b.page.getByRole('region', { name: 'Sync issues' })
    await expect(issues.getByText('This record changed on another device.')).toBeVisible()
    await issues.getByText('Compare local and server versions').click()
    await expect(issues.locator('pre').first()).toContainText('死锁状态')
    await expect(issues.locator('pre').last()).toContainText('"meaning": "死锁"')
    await expect(issues.getByRole('button', { name: 'Use server version' })).toBeEnabled()
    await issues.getByRole('button', { name: 'Keep local and resubmit' }).click()
    await waitSynced(b.page)
    await syncNow(a.page)
    await a.page.goto(path)
    await expect(a.page.getByText('死锁状态', { exact: true })).toBeVisible()

    const cursor = (await records(b.page, 'sync_state'))[0].cursor
    await b.page.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === 'entries' && value?.term === 'semaphore') throw new DOMException('Injected failure', 'QuotaExceededError')
        return put.call(this, value, key)
      }
      window.addEventListener('lexyn-test-restore-put', () => { IDBObjectStore.prototype.put = put }, { once: true })
    })
    await addWord(a.page, 'semaphore', '信号量')
    await settings(a.page)
    await syncNow(a.page)
    await b.page.getByRole('button', { name: 'Sync now' }).click()
    await expect(b.page.getByText('Synchronization could not finish.', { exact: false })).toBeVisible()
    expect((await records(b.page, 'sync_state'))[0].cursor).toBe(cursor)
    await b.page.evaluate(() => window.dispatchEvent(new Event('lexyn-test-restore-put')))
    await syncNow(b.page)
    expect((await records(b.page, 'sync_state'))[0].cursor).toBeGreaterThan(cursor)
    await b.page.goto(path)
    await expect(b.page.getByRole('heading', { name: 'semaphore', exact: true })).toBeVisible()
  } finally {
    await Promise.all([a.context.close(), b.context.close()])
  }
})

test('retains offline writes after a lost session and only one tab pushes the shared Outbox', async ({ browser, baseURL }) => {
  const client = await device(browser, baseURL)
  const { context, page } = client
  let allowPush: (() => void) | undefined
  try {
    await page.goto('/settings')
    await signIn(page)
    await context.setOffline(true)
    await createDeck(page, 'Offline after session expiry')
    await addWord(page, 'quorum', '法定人数')
    await settings(page)
    await context.clearCookies()
    await context.setOffline(false)
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    const queued = await records(page, 'client_outbox')
    expect(queued).toHaveLength(2)

    let pushes = 0
    const gate = new Promise<void>((resolve) => { allowPush = resolve })
    const firstId = queued.find(({ kind }) => kind === 'deck.create')!.opId
    await context.route('**/api/sync/push', async (route) => {
      const body = route.request().postDataJSON() as PushRequest
      if (body.operations.some(({ opId }) => opId === firstId)) {
        pushes++
        await gate
      }
      await route.continue()
    })
    await page.getByLabel('Owner password').fill(password())
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect.poll(() => pushes).toBe(1)
    const second = await context.newPage()
    await second.goto('/settings')
    await expect(second.getByText('Signed in as Owner')).toBeVisible()
    await second.getByRole('button', { name: 'Sync now' }).click()
    expect(pushes).toBe(1)
    expect(await records(second, 'client_outbox')).toEqual(queued)
    allowPush?.()
    await waitSynced(page)
    await waitSynced(second)
    expect(pushes).toBe(1)
  } finally {
    allowPush?.()
    await context.close()
  }
})
