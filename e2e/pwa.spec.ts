import { mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { Page } from '@playwright/test'
import { expect, password, signIn, studyRequest, test, username } from './fixtures'
import { createApp } from '../server/app'
import { initializeOwner } from '../server/auth/owner'
import { openDatabase } from '../server/db/database'

async function controlled(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

async function createWord(page: Page, name: string) {
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).click()
  await page.getByRole('button', { name: 'Add word' }).click()
  await page.getByLabel('Term', { exact: true }).fill('resilience')
  await page.getByLabel('Meaning optional').fill('韧性')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'resilience', exact: true })).toBeVisible()
  return new URL(page.url()).pathname
}

async function copyOne(page: Page) {
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 1 new word' }).click()
  await page.getByRole('textbox', { name: 'Copy the word' }).fill('resilience')
  await page.getByRole('button', { name: 'Check spelling' }).click()
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
}

async function rateGood(page: Page) {
  await page.getByRole('button', { name: 'Start review' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
}

async function cachedPaths(page: Page) {
  return page.evaluate(async () => {
    const urls = []
    for (const key of await caches.keys()) urls.push(...(await (await caches.open(key)).keys()).map(({ url }) => new URL(url).pathname))
    return urls
  })
}

async function counts(page: Page) {
  const response = await studyRequest(page, 'backup/library', [null])
  const { data } = await response.json()
  return [data.practiceEvents.length, data.reviewEvents.length]
}

test('serves the manifest, worker and icons directly with correct types and cache headers', async ({ request }) => {
  const assets = [
    ['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'javascript'], ['/favicon.svg', 'image/svg+xml'],
    ['/pwa-192.png', 'image/png'], ['/pwa-512.png', 'image/png'], ['/pwa-512-maskable.png', 'image/png'],
  ]
  for (const [path, type] of assets) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain(type)
    expect(response.headers()['cache-control']).toBe('no-cache')
    expect(response.headers().location).toBeUndefined()
    if (type === 'image/png') {
      const png = await response.body()
      const size = Number(path.match(/\d+/)![0])
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size])
    }
  }
  expect(await (await request.get('/manifest.webmanifest')).json()).toMatchObject({
    name: 'Lexyn', short_name: 'Lexyn', description: '学习、回忆、巩固。', lang: 'zh-CN', start_url: '/', scope: '/', display: 'standalone',
    theme_color: '#285b47', background_color: '#fffefa',
    icons: [
      { src: '/pwa-192.png', sizes: '192x192', purpose: 'any' },
      { src: '/pwa-512.png', sizes: '512x512', purpose: 'any' },
      { src: '/pwa-512-maskable.png', sizes: '512x512', purpose: 'maskable' },
    ],
  })
  for (const path of ['/', '/library', '/learn', '/review', '/settings']) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/html')
    expect(response.headers()['cache-control']).toBe('no-cache')
  }
  expect((await request.get('/missing.webmanifest')).status()).toBe(404)
  expect((await request.get('/assets/absent.js')).status()).toBe(404)
})

test('cold launches the static shell offline without private data or study writes', async ({ context, page }) => {
  await controlled(page)
  await createWord(page, 'Private PWA deck')
  const keys = await cachedPaths(page)
  expect(keys).toEqual(expect.arrayContaining(['/index.html', '/manifest.webmanifest', '/favicon.svg', expect.stringMatching(/\.css$/), expect.stringMatching(/\.js$/)]))
  expect(keys.some((path) => path === '/api' || path.startsWith('/api/'))).toBe(false)
  await page.close()
  await context.setOffline(true)
  const offline = await context.newPage()
  await offline.goto('/library')
  await controlled(offline)
  await expect(offline.locator('.service-status')).toHaveText('Connection unavailable')
  await expect(offline.getByRole('button', { name: 'Retry connection' })).toBeVisible()
  await expect(offline.getByText('Private PWA deck')).toHaveCount(0)
  await expect(offline.getByRole('button', { name: 'New deck' })).toHaveCount(0)
  expect(await offline.evaluate(() => indexedDB.databases())).toEqual([])
  await context.setOffline(false)
  await expect(offline.getByRole('link', { name: 'Private PWA deck' })).toBeVisible()
  expect(await counts(offline)).toEqual([0, 0])
  expect((await cachedPaths(offline)).sort()).toEqual(keys.sort())
})

test('stages a new shell while open, retains the old shell on install failure and preserves server records', async ({ browser }) => {
  const root = await mkdtemp(join(tmpdir(), 'lexyn-update-'))
  const web = join(root, 'web')
  await cp('dist', web, { recursive: true })
  const db = openDatabase(root)
  await initializeOwner(db, username, password)
  let app: ReturnType<typeof createApp>
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const instance = serve({ fetch: (request) => app.fetch(request), hostname: '127.0.0.1', port: 0 }, () => resolve(instance))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing update test server address')
  const baseURL = `http://127.0.0.1:${address.port}`
  app = createApp(db, web, baseURL)
  const context = await browser.newContext({ baseURL })
  try {
    const page = await context.newPage()
    await page.goto('/library')
    await controlled(page)
    await signIn(page)
    await createWord(page, 'PWA update data')
    await copyOne(page)
    await page.getByRole('link', { name: 'Review', exact: true }).click()
    await rateGood(page)
    expect(await counts(page)).toEqual([1, 1])
    const path = join(web, 'sw.js')
    const oldWorker = await readFile(path, 'utf8')
    const nextWorker = oldWorker.replace(/^const version = "[^"]+"/, 'const version = "next-test-version"')
    await writeFile(path, nextWorker.replace('const prefix', 'precache["/index.html"].sha256 = "bad-digest"\nconst prefix'))
    expect(await page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!
      const state = new Promise<string>((resolve) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing!
          worker.addEventListener('statechange', () => {
            if (['redundant', 'installed'].includes(worker.state)) resolve(worker.state)
          })
        }, { once: true })
      })
      await registration.update()
      return state
    })).toBe('redundant')
    expect(await page.evaluate(() => caches.keys())).toHaveLength(1)
    await writeFile(path, nextWorker)
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update())
    await expect(page.getByText('New version available.', { exact: false })).toBeVisible()
    expect(await counts(page)).toEqual([1, 1])
    await page.close()
    const reopened = await context.newPage()
    await reopened.goto('/library')
    await controlled(reopened)
    await expect.poll(() => reopened.evaluate(() => caches.keys())).toEqual(['lexyn-shell-next-test-version'])
    await expect(reopened.getByRole('link', { name: 'PWA update data', exact: true })).toBeVisible()
    expect(await counts(reopened)).toEqual([1, 1])
  } finally {
    await context.close()
    await new Promise<void>((resolve) => { server.close(() => resolve()); if ('closeAllConnections' in server) server.closeAllConnections() })
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
