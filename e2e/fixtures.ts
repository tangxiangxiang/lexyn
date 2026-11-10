import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { test as base, expect, type Page } from '@playwright/test'
import { createApp } from '../server/app'
import { createBootstrapState } from '../server/auth/bootstrap'
import { initializeOwner } from '../server/auth/owner'
import { openDatabase } from '../server/db/database'

export const username = 'test-admin'
export const password = process.env.LEXYN_TEST_OWNER_PASSWORD ??= randomBytes(24).toString('base64url')

export async function signIn(page: Page) {
  await page.getByText('English', { exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Owner password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.service-status')).toHaveText('Connected')
}

export async function studyRequest(page: Page, path: string, args: unknown[] = [], key?: string) {
  const headers = { 'X-Lexyn-Client': '1' }
  const response = await page.request.get('/api/auth/session', { headers })
  const { session } = await response.json()
  const auth = { ...headers, 'X-Lexyn-Owner': session.ownerId }
  if (key) return page.request.post('/api/' + path, {
    headers: { ...auth, Origin: new URL(page.url()).origin, 'Idempotency-Key': key }, data: args,
  })
  return page.request.get('/api/' + path, { headers: auth, params: { args: JSON.stringify(args) } })
}
export const writeStudy = (page: Page, path: string, args: unknown[], key: string = randomUUID()) => studyRequest(page, path, args, key)

async function startFixture(initialOwner: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'lexyn-e2e-'))
  const db = openDatabase(directory)
  const setupToken = initialOwner ? undefined : randomBytes(32).toString('base64url')
  if (initialOwner) await initializeOwner(db, username, password)
  let now: number | undefined
  let app: ReturnType<typeof createApp>
  const server = serve({ fetch: (request) => app.fetch(request), hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address.')
  const origin = `http://127.0.0.1:${address.port}`
  app = createApp(db, resolve('dist'), origin, () => now ?? Date.now(),
    { bootstrap: setupToken ? createBootstrapState(setupToken) : undefined })
  return { origin, db, setupToken, advanceTo: (time: number) => { now = time }, close: async () => {
    await new Promise<void>((done) => { server.close(() => done()); if ('closeAllConnections' in server) server.closeAllConnections() })
    db.close()
    rmSync(directory, { recursive: true, force: true })
  } }
}

export const test = base.extend<{ backend: Awaited<ReturnType<typeof startFixture>>; initialOwner: boolean; englishUI: boolean }>({
  initialOwner: [true, { option: true }],
  englishUI: [true, { option: true }],
  backend: async ({ initialOwner }, use) => {
    const fixture = await startFixture(initialOwner)
    try { await use(fixture) } finally { await fixture.close() }
  },
  baseURL: async ({ backend }, use) => { await use(backend.origin) },
  page: async ({ page, initialOwner, englishUI }, use) => {
    if (englishUI) await page.addInitScript(() => {
      if (!localStorage.getItem('lexyn.locale')) localStorage.setItem('lexyn.locale', 'en')
    })
    await page.goto('/library')
    if (initialOwner) await signIn(page)
    await use(page)
  },
})
export { expect }
