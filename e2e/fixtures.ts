import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { createApp } from '../server/app'
import { createBootstrapState } from '../server/auth/bootstrap'
import { initializeOwner } from '../server/auth/owner'
import { openDatabase } from '../server/db/database'
import { createSpeechCredentials } from '../server/speech/credentials'
import { mockSpeechResponse } from './mock-speech'

export const username = 'test-admin'
export const password = process.env.LEXYN_TEST_OWNER_PASSWORD ??= randomBytes(24).toString('base64url')

export async function signIn(page: Page) {
  await page.getByText('English', { exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Owner password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('main#main')).toBeVisible()
  const session = await page.request.get(new URL('/api/auth/session', page.url()).href, {
    headers: { 'X-Lexyn-Client': '1' },
  })
  expect(session.ok()).toBe(true)
  expect(await session.json()).toMatchObject({ session: { username, ownerId: expect.any(String) } })
}

export async function libraryAction(scope: Page | Locator, action: string, menu?: string) {
  const summary = menu === 'Deck options' ? scope.locator('.app-menu > summary')
    : menu ? scope.locator('summary').and(scope.getByLabel(menu, { exact: true })) : scope.locator('.word-menu summary')
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open))) await summary.click()
  await scope.getByRole('button', { name: action, exact: true }).click()
}

export function wordbookLink(page: Page, name: string) {
  return page.getByRole('link').filter({ has: page.getByRole('heading', { name, exact: true }) })
}

export async function openStudyLists(page: Page, name: string, touch = false) {
  const activate = (control: Locator) => touch ? control.tap() : control.click()
  await activate(wordbookLink(page, name))
  await activate(page.locator('summary').and(page.getByLabel('Word list options')))
  await activate(page.getByRole('link', { name: 'Study lists', exact: true }))
}

export async function navigateFromMenu(page: Page, name: string, touch = false) {
  const activate = (control: Locator) => touch ? control.tap() : control.click()
  const main = page.getByRole('main')
  const homeLink = main.locator('.spell-home-tools').getByRole('link', { name, exact: true })
  if (await homeLink.isVisible()) {
    await activate(homeLink)
    return
  }
  const navigation = page.getByRole('navigation')
  await activate(navigation.locator('summary'))
  await activate(navigation.getByRole('link', { name, exact: true }))
}

/** Fill the current structured meaning editor without relying on the legacy short-meaning field. */
export async function fillMeaning(page: Page, text: string, partOfSpeech = '') {
  const definition = page.getByLabel('Definition 1', { exact: true }).first()
  if (await definition.count()) {
    await definition.fill(text)
    if (partOfSpeech) await page.getByLabel('Part of speech', { exact: true }).first().fill(partOfSpeech)
    return
  }
  await page.getByRole('button', { name: 'Add meaning group', exact: true }).click()
  if (partOfSpeech) await page.getByLabel('Part of speech', { exact: true }).first().fill(partOfSpeech)
  await page.getByLabel('Definition 1', { exact: true }).first().fill(text)
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

async function startFixture(initialOwner: boolean, speechConfigured: boolean, schemaVersion?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'lexyn-e2e-'))
  const db = openDatabase(directory, schemaVersion)
  const setupToken = initialOwner ? undefined : randomBytes(32).toString('base64url')
  if (initialOwner) await initializeOwner(db, username, password)
  if (initialOwner && speechConfigured) {
    const owner = db.prepare('SELECT id FROM owner').pluck().get() as string
    createSpeechCredentials(db, directory).save(owner, 'mock-key')
  }
  let now: number | undefined
  let app: ReturnType<typeof createApp>
  const server = serve({ fetch: (request) => app.fetch(request), hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address.')
  const origin = `http://127.0.0.1:${address.port}`
  const speech = { requests: [] as { text: string; voice_setting: { voice_id: string } }[], failNext: false }
  const vocabulary = {
    requests: [] as string[][],
    inputs: [] as { ref: number; term: string; currentMeaning?: { text: string }; dictionaryReference?: unknown }[][],
    responses: [] as string[][],
    beforeReply: undefined as (() => Promise<void>) | undefined,
  }
  app = createApp(db, resolve('dist'), origin, () => now ?? Date.now(),
    { bootstrap: setupToken ? createBootstrapState(setupToken) : undefined }, {
      dataDir: directory,
      fetch: async (_url, init) => {
        speech.requests.push(JSON.parse(String(init?.body)))
        if (speech.failNext) {
          speech.failNext = false
          return new Response(null, { status: 503 })
        }
        return mockSpeechResponse()
      },
    }, async (_url, init) => {
      const { messages } = JSON.parse(String(init?.body))
      const { words } = JSON.parse(messages[1].content) as {
        words: { ref: number; term: string; currentMeaning?: { text: string }; dictionaryReference?: unknown }[]
      }
      vocabulary.requests.push(words.map(({ term }) => term))
      vocabulary.inputs.push(words)
      await vocabulary.beforeReply?.()
      vocabulary.responses.push(words.map(({ term }) => term))
      const ipaOnly = messages[0].content.includes('Do not generate meanings.')
      const results = words.map((word) => ({
        ref: word.ref,
        term: word.term,
        ...(!ipaOnly ? { senses: ['missing', 'wal'].includes(word.term.toLowerCase()) ? [] : word.term.toLowerCase() === 'banana'
          ? [{ partOfSpeech: 'n.', definitions: [word.currentMeaning ? '香蕉的迭代释义 C' : '香蕉', '热带水果'] }]
          : [{ partOfSpeech: 'n.', definitions: [['queue', 'queues'].includes(word.term.toLowerCase()) ? '队列'
            : word.term.toLowerCase() === 'thread' ? word.currentMeaning ? '线程的迭代释义 C' : '线程'
              : word.term.toLowerCase() === 'concurrency' ? '并发' : word.term.toLowerCase() === 'deadlock' ? '死锁'
                : word.term.toLowerCase() === 'latch' ? '闩锁' : word.term.toLowerCase() === 'cache' ? '缓存'
                  : word.term.toLowerCase() === 'mutex' ? '互斥锁' : '确定性'] }] } : {}),
        phonetics: word.term === 'command' ? { british: 'kəˈmɑːnd', american: 'kəˈmænd' } : null,
        needsReview: false,
        warning: ['missing', 'wal'].includes(word.term.toLowerCase()) ? '无法确定可靠释义' : null,
      }))
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] })
    })
  return { origin, db, directory, setupToken, speech, vocabulary, advanceTo: (time: number) => { now = time }, close: async () => {
    await new Promise<void>((done) => { server.close(() => done()); if ('closeAllConnections' in server) server.closeAllConnections() })
    db.close()
    rmSync(directory, { recursive: true, force: true })
  } }
}

export const test = base.extend<{
  backend: Awaited<ReturnType<typeof startFixture>>; initialOwner: boolean; englishUI: boolean; speechConfigured: boolean; schemaVersion?: number
}>({
  initialOwner: [true, { option: true }],
  schemaVersion: [undefined, { option: true }],
  englishUI: [true, { option: true }],
  speechConfigured: [true, { option: true }],
  backend: async ({ initialOwner, speechConfigured, schemaVersion }, use) => {
    const fixture = await startFixture(initialOwner, speechConfigured, schemaVersion)
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
