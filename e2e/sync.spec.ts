import { expect, test, type Browser, type Page, type Response } from '@playwright/test'
import type { OutboxOperation } from '../shared/contracts/library'
import type { PushRequest, PushResponse } from '../shared/contracts/sync'
import type { LearnProgress } from '../shared/domain/learning'
import type { ReviewCard, ReviewEvent } from '../shared/domain/review'
import { rebuildCardFromEvents } from '../shared/srs/scheduler'
import type { SyncIssue, SyncState } from '../src/features/sync/types'

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
  return waitSynced(page)
}

async function syncSnapshot(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('lexyn')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      const tx = database.transaction(['sync_state', 'sync_issues', 'client_outbox'])
      const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [state, issues, outboxKeys] = await Promise.all([
        read<SyncState | undefined>(tx.objectStore('sync_state').get('state')),
        read<SyncIssue[]>(tx.objectStore('sync_issues').getAll()),
        read(tx.objectStore('client_outbox').getAllKeys()),
      ])
      const resolved = new Set(issues.filter(({ status }) => status === 'resolved').map(({ opId }) => opId))
      const region = document.querySelector('section[aria-label="Synchronization"]')
      const pending = [...(region?.querySelectorAll('p') ?? [])]
        .map((node) => node.textContent?.match(/^(\d+) pending operations$/)).find(Boolean)
      return {
        status: region?.querySelector('.sync-status')?.textContent?.trim(),
        pending: pending ? Number(pending[1]) : undefined,
        outboxPending: outboxKeys.filter((key) => typeof key !== 'string' || !resolved.has(key)).length,
        unresolvedIssues: issues.filter(({ status }) => status !== 'resolved').length,
        deviceId: state?.deviceId.slice(0, 8),
        cursor: state?.cursor,
        bootstrapped: state?.bootstrapped,
        leasePresent: Boolean(state?.leaseId),
        leaseActive: Boolean(state?.leaseId && (state.leaseUntil ?? 0) > Date.now()),
        lastSuccessAt: state?.lastSuccessAt,
        online: navigator.onLine,
        error: region?.querySelector('[role="alert"]')?.textContent?.trim() ?? '',
      }
    } finally { database.close() }
  })
}

async function waitSynced(page: Page, minCursor = 0) {
  let cursor = -1
  await expect.poll(async () => {
    const state = await syncSnapshot(page)
    cursor = state.cursor ?? -1
    return {
      status: state.status, pending: state.pending, outboxPending: state.outboxPending, unresolvedIssues: state.unresolvedIssues,
      bootstrapped: state.bootstrapped, leasePresent: state.leasePresent, online: state.online,
      hasError: Boolean(state.error), hasSuccess: state.lastSuccessAt !== undefined,
      cursorReached: cursor >= minCursor,
    }
  }, { timeout: 10_000, message: `Sync should finish and apply changes through cursor ${minCursor}` }).toEqual({
    status: 'Synced', pending: 0, outboxPending: 0, unresolvedIssues: 0,
    bootstrapped: true, leasePresent: false, online: true,
    hasError: false, hasSuccess: true, cursorReached: true,
  })
  return cursor
}

async function syncNow(page: Page, step: string, minCursor = 0) {
  return test.step(step, async () => {
    const responses: { endpoint: string; status: number }[] = []
    const recordResponse = (response: Response) => {
      const endpoint = new URL(response.url()).pathname
      if (['/api/bootstrap', '/api/sync/push', '/api/sync/pull'].includes(endpoint)) {
        responses.push({ endpoint, status: response.status() })
      }
    }
    page.on('response', recordResponse)
    try {
      await page.getByRole('button', { name: 'Sync now' }).click({ timeout: 15_000 })
      return await waitSynced(page, minCursor)
    } catch (error) {
      const state = await syncSnapshot(page).catch(() => undefined)
      if (state) state.error = state.error.replaceAll(password(), '[redacted]')
      const diagnostics = { step, minCursor, responses, state }
      // The CI dot reporter truncates text attachments.
      console.info('Sync diagnostics:', JSON.stringify(diagnostics))
      await test.info().attach('sync diagnostics', { body: JSON.stringify(diagnostics, null, 2) })
      throw error
    } finally { page.off('response', recordResponse) }
  })
}

async function retryAfterLostReviewAck(page: Page, opId: string, reconnect: () => Promise<void>) {
  const syncButton = page.getByRole('button', { name: 'Sync now' })
  await syncButton.evaluate((button, opId) => {
    const fetch = window.fetch.bind(window)
    let forwarded = false
    // Keep background retries from winning the race with the manual retry.
    button.addEventListener('click', () => { window.fetch = fetch }, { capture: true, once: true })
    window.fetch = async (input, init) => {
      if (input !== '/api/sync/push' || typeof init?.body !== 'string'
        || !(JSON.parse(init.body) as PushRequest).operations.some((operation) => operation.opId === opId)) {
        return fetch(input, init)
      }
      if (forwarded) return new Response(null, { status: 503 })
      forwarded = true
      // Use the browser's real authenticated request, then lose the ACK at the client boundary.
      const response = await fetch(input, init)
      await response.arrayBuffer()
      throw new TypeError('Injected lost sync response')
    }
  }, opId)

  const receipt = async () => {
    const response = await page.waitForResponse((response) => {
      const request = response.request()
      return new URL(response.url()).pathname === '/api/sync/push' && request.method() === 'POST'
        && (request.postDataJSON() as PushRequest).operations.some((operation) => operation.opId === opId)
    }, { timeout: 15_000 })
    expect(response.ok()).toBe(true)
    const { results } = await response.json() as PushResponse
    return results
  }

  const [accepted] = await Promise.all([receipt(), reconnect()])
  expect(accepted).toEqual([{ opId, status: 'accepted', serverSeq: expect.any(Number) }])
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible()
  expect(await records(page, 'client_outbox')).toMatchObject([{ operationId: opId }])

  const serverSeq = accepted[0].status === 'accepted' ? accepted[0].serverSeq : null
  const [retried] = await Promise.all([receipt(), syncNow(page, 'Retry the unacknowledged review', serverSeq ?? 0)])
  expect(retried).toEqual(accepted.map((result) => ({ ...result, status: 'already_applied' })))
}

async function createDeck(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click()
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).click()
}

async function openDeck(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click()
  await page.getByRole('link', { name, exact: true }).click()
}

async function openReview(page: Page, deckName: string) {
  // A full navigation can interrupt sync and leave a lease that cannot expire with a fixed clock.
  await page.getByRole('navigation').getByRole('link', { name: 'Review' }).click()
  await page.getByLabel('Review deck').click()
  await page.getByText(deckName, { exact: true }).click()
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
  test(`two devices retain both offline ratings and converge (${reverse ? 'phone' : 'desktop'} pushes first)`, async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(90_000)
    const a = await device(browser, baseURL)
    const b = await device(browser, baseURL, true)
    try {
      const time = Date.now() - 86_400_000
      await a.page.clock.setFixedTime(time)
      await b.page.clock.setFixedTime(time)
      await a.page.goto('/library')
      const deckName = `${reverse ? 'Phone' : 'Desktop'} first systems ${testInfo.repeatEachIndex + 1}`
      await createDeck(a.page, deckName)
      await addWord(a.page, 'concurrency', '并发')
      await learnWord(a.page, 'concurrency')
      const legacy = (await records(a.page, 'client_outbox')).sort((left, right) => left.sequence - right.sequence)
      expect(legacy.map(({ kind }) => kind)).toEqual(['deck.create', 'entry.create', 'practice.create'])
      await settings(a.page)
      await signIn(a.page)

      await b.page.goto('/settings')
      const phoneBootstrapCursor = await signIn(b.page)
      expect(await b.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
      expect((await records(a.page, 'sync_state'))[0].deviceId).not.toBe((await records(b.page, 'sync_state'))[0].deviceId)
      await openDeck(b.page, deckName)
      await expect(b.page.getByRole('heading', { name: 'concurrency', exact: true })).toBeVisible()
      const word = legacy[1].payload.id
      expect((await records(b.page, 'learn_progress')).find(({ entryId }) => entryId === word))
        .toMatchObject({ firstCompletedAt: time, completedCount: 1 })

      await openReview(b.page, deckName)
      await expect(b.page.getByText('Waiting for first recall', { exact: true })).toBeVisible()
      await rate(b.page, 'Again')
      await settings(b.page)
      const initialReviewCursor = await syncNow(b.page, 'Publish the first phone rating', phoneBootstrapCursor + 1)
      await syncNow(a.page, 'Download the first phone rating on desktop', initialReviewCursor)
      const [initial] = (await records(a.page, 'review_cards')).filter(({ entryId }) => entryId === word)
      expect(initial.schedulerState.stabilityFast).toBeGreaterThan(0)
      await Promise.all([a.context.setOffline(true), b.context.setOffline(true)])
      await a.page.clock.setFixedTime(initial.dueAt + 1)
      await b.page.clock.setFixedTime(initial.dueAt + 2)
      await openReview(a.page, deckName)
      await openReview(b.page, deckName)
      await expect(a.page.getByRole('button', { name: 'Start review' })).toBeEnabled()
      await expect(b.page.getByRole('button', { name: 'Start review' })).toBeEnabled()
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
        await test.step('recover the original review operation after the server ACK is lost', async () => {
          await retryAfterLostReviewAck(first.page, aPending[0].opId, () => first.context.setOffline(false))
        })
      } else {
        await first.context.setOffline(false)
        await syncNow(first.page, 'Publish the offline phone rating', initialReviewCursor + 1)
      }
      expect(await records(second.page, 'client_outbox')).toHaveLength(1)
      await second.context.setOffline(false)
      const mergedCursor = await syncNow(second.page, 'Publish the second rating and download the merged history', initialReviewCursor + 2)
      await syncNow(first.page, 'Download the merged history on the first device', mergedCursor)

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
        await openDeck(a.page, deckName)
        await addWord(a.page, 'mutex', '互斥锁')
        expect(await records(a.page, 'client_outbox')).toHaveLength(1)
        await settings(a.page)
        const newWordCursor = await signIn(a.page)
        expect((await records(a.page, 'sync_state'))[0].deviceId).toBe(deviceId)
        await syncNow(b.page, 'Download the word added while signed out', newWordCursor)
        await openDeck(b.page, deckName)
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
    const deckName = 'Conflict systems'
    await createDeck(a.page, deckName)
    await addWord(a.page, 'deadlock', '原释义')
    await settings(a.page)
    const createdCursor = await syncNow(a.page, 'Publish the conflict fixture')
    await syncNow(b.page, 'Download the conflict fixture', createdCursor)
    await openDeck(a.page, deckName)
    await openDeck(b.page, deckName)
    await Promise.all([a.context.setOffline(true), b.context.setOffline(true)])
    await editWord(a.page, '死锁')
    await editWord(b.page, '死锁状态')
    await settings(a.page)
    await settings(b.page)
    await a.context.setOffline(false)
    await syncNow(a.page, 'Publish the first offline edit', createdCursor + 1)
    await b.context.setOffline(false)
    await b.page.getByRole('button', { name: 'Sync now' }).click()
    const issues = b.page.getByRole('region', { name: 'Sync issues' })
    await expect(issues.getByText('This record changed on another device.')).toBeVisible()
    await issues.getByText('Compare local and server versions').click()
    await expect(issues.locator('pre').first()).toContainText('死锁状态')
    await expect(issues.locator('pre').last()).toContainText('"meaning": "死锁"')
    await expect(issues.getByRole('button', { name: 'Use server version' })).toBeEnabled()
    await issues.getByRole('button', { name: 'Keep local and resubmit' }).click()
    const resolvedCursor = await waitSynced(b.page)
    await syncNow(a.page, 'Download the resolved edit', resolvedCursor)
    await openDeck(a.page, deckName)
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
    const semaphoreCursor = await syncNow(a.page, 'Publish the word used to test pull rollback')
    await b.page.getByRole('button', { name: 'Sync now' }).click()
    await expect(b.page.getByText('Synchronization could not finish.', { exact: false })).toBeVisible()
    expect((await records(b.page, 'sync_state'))[0].cursor).toBe(cursor)
    await b.page.evaluate(() => window.dispatchEvent(new Event('lexyn-test-restore-put')))
    await syncNow(b.page, 'Retry the failed pull', semaphoreCursor)
    expect((await records(b.page, 'sync_state'))[0].cursor).toBeGreaterThan(cursor)
    await openDeck(b.page, deckName)
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
