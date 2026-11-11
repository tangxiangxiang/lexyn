import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import type { Page } from '@playwright/test'
import { expect, libraryAction, password, signIn, test, username } from './fixtures'
import { createApp } from '../server/app'
import { lockDataDirectory, openDatabase } from '../server/db/database'
import type { LibraryExport } from '../shared/contracts/library'
import { prepareLibraryRestore } from '../shared/backup/library'

const execute = promisify(execFile)

async function command(dataDir: string, args: string[], input?: string) {
  const env = { ...process.env, NODE_ENV: 'test', LEXYN_DATA_DIR: dataDir, LEXYN_PUBLIC_ORIGIN: 'http://127.0.0.1:4173' }
  if (input !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, args, { env }, (error) => error ? reject(error) : resolve())
      child.stdin!.end(input + '\n')
    })
    return ''
  }
  return (await execute(process.execPath, args, { env })).stdout
}

const init = (dataDir: string) => command(dataDir, ['dist-server/server/auth/init-owner.js', username], password)
const backup = (dataDir: string, ...args: string[]) => command(dataDir, ['dist-server/server/backup/cli.js', ...args])

async function start(dataDir: string, port = 0) {
  const unlock = lockDataDirectory(dataDir)
  const db = openDatabase(dataDir)
  let app: ReturnType<typeof createApp>
  let origin: string
  const server = serve({ hostname: '127.0.0.1', port, fetch: (request) => app.fetch(request) })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing recovery server address.')
  origin = `http://127.0.0.1:${address.port}`
  app = createApp(db, resolve('dist'), origin)
  return { db, origin, port: address.port, close: async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      if ('closeAllConnections' in server) server.closeAllConnections()
    })
    try { db.close() } finally { unlock() }
  } }
}

const settings = (page: Page) => page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click()
async function newDeck(page: Page, name: string, csv: string) {
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click()
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).click()
  await libraryAction(page, 'Import words', 'Deck options')
  await page.getByLabel('Vocabulary file').setInputFiles({ name: 'words.csv', mimeType: 'text/csv', buffer: Buffer.from(`term,meaning\n${csv}`) })
  await page.getByRole('button', { name: /^Import \d+ words?$/ }).click()
  await expect(page.getByRole('heading', { name: csv.split(',')[0], exact: true })).toBeVisible()
}

async function study(page: Page, amount: number) {
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: new RegExp(`Learn ${amount} new words?`) }).click()
  for (let index = 0; index < amount; index++) {
    const term = page.locator('.learn-term')
    await expect(term).toBeVisible()
    const spelling = await term.innerText()
    await page.getByRole('textbox', { name: 'Copy the word' }).fill(spelling)
    await page.getByRole('button', { name: 'Check spelling' }).click()
    await page.getByRole('button', { name: 'Next word' }).click()
    await expect(page.getByRole('heading', { name: spelling, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: 'Review' }).click()
  await page.getByRole('button', { name: 'Start review' }).click()
  for (let index = 0; index < amount; index++) {
    await page.getByRole('button', { name: 'Show answer' }).click()
    await page.getByRole('button', { name: 'Good', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Review round complete' })).toBeVisible()
}

async function exportLibrary(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON backup' }).click(),
  ])
  const path = await download.path()
  return { path, snapshot: JSON.parse(await readFile(path, 'utf8')) as LibraryExport }
}

function comparable({ exportedAt: _, reviewCards, ...data }: LibraryExport) {
  // The replayed numeric state is compared separately by the backup validator.
  return { ...data, reviewCards: reviewCards.map(({ schedulerState, ...card }) => ({ ...card, dueAt: schedulerState.dueAt })) }
}

test('restores a server JSON export with archived and removed history for fresh devices', async ({ page, browser }) => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'lexyn-json-e2e-'))
  const fresh = await browser.newContext()
  let server: Awaited<ReturnType<typeof start>> | undefined
  try {
    await page.goto('/library')
    await newDeck(page, 'JSON current deck', 'consensus,共识\nquorum,法定人数\nreplica,副本')
    await study(page, 3)
    await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click()
    await page.getByRole('link', { name: 'JSON current deck', exact: true }).click()
    await libraryAction(page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'quorum', exact: true }) }), 'Remove word')
    await page.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
    await newDeck(page, 'JSON archived deck', 'wal,日志')
    await page.getByRole('link', { name: 'Back to Library' }).click()
    await libraryAction(page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'JSON archived deck', exact: true }) }), 'Archive deck', 'Book options')
    await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
    await settings(page)
    await page.getByRole('textbox', { name: 'Daily new words' }).fill('23')
    await page.getByRole('textbox', { name: 'Daily new words' }).press('Tab')
    const { path, snapshot } = await exportLibrary(page)
    expect(snapshot.settings.dailyNewWords).toBe(23)
    expect(snapshot.reviewEvents).toHaveLength(3)
    expect(snapshot.practiceEvents).toHaveLength(3)
    await page.getByLabel('Preview a JSON backup').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') })
    await expect(page.getByText('The file is not valid JSON.')).toBeVisible()
    await page.getByLabel('Preview a JSON backup').setInputFiles(path)
    await expect(page.getByRole('heading', { name: 'Backup preview' })).toBeVisible()
    await init(root)
    await expect(backup(root, 'restore-json', path)).rejects.toThrow('--confirm-empty')
    await backup(root, 'restore-json', path, '--confirm-empty')
    await expect(backup(root, 'restore-json', path, '--confirm-empty')).rejects.toThrow('empty server')
    server = await start(root)
    const restored = await fresh.newPage()
    await restored.goto(server.origin + '/settings')
    await signIn(restored)
    await expect(restored.getByRole('textbox', { name: 'Daily new words' })).toHaveValue('23')
    const roundTrip = await exportLibrary(restored)
    expect(comparable(roundTrip.snapshot)).toEqual(comparable(snapshot))
    const plan = await prepareLibraryRestore(JSON.stringify(roundTrip.snapshot))
    expect(plan.reviewChanges).toHaveLength(3)
    expect(plan.reviewChanges.every(({ card }) => card.schedulerState.stabilityFast > 0)).toBe(true)
  } finally {
    await fresh.close()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('recovers a live SQLite backup, revokes old sessions and persists new writes after restart', async ({ browser }) => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'lexyn-sqlite-e2e-'))
  const source = join(root, 'source')
  const target = join(root, 'restored')
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  let instance: Awaited<ReturnType<typeof start>> | undefined
  try {
    await init(source)
    instance = await start(source)
    const [desktop, phone] = await Promise.all(contexts.map((context) => context.newPage()))
    await desktop.goto(instance.origin + '/library')
    await signIn(desktop)
    await newDeck(desktop, 'SQLite desktop data', 'durability,耐久性')
    await study(desktop, 1)
    await phone.goto(instance.origin + '/library')
    await signIn(phone)
    await expect(phone.getByRole('link', { name: 'SQLite desktop data' })).toBeVisible()
    await newDeck(phone, 'SQLite phone data', 'checkpoint,检查点')
    await study(phone, 1)
    await settings(phone)
    await expect(phone.getByLabel('Study timezone (IANA)')).toHaveValue('UTC')
    await phone.getByLabel('Study timezone (IANA)').fill('Asia/Shanghai')
    const [saved] = await Promise.all([phone.waitForResponse((response) => response.url().endsWith('/api/settings/timezone')),
      phone.getByRole('button', { name: 'Save timezone' }).click()])
    expect(saved.ok()).toBe(true)
    const snapshot = (await exportLibrary(phone)).snapshot
    expect(snapshot.settings.timezone).toBe('Asia/Shanghai')
    expect(snapshot.reviewEvents).toHaveLength(2)
    expect(snapshot.practiceEvents).toHaveLength(2)
    const { directory } = JSON.parse(await backup(source, 'create', join(root, 'backups'))) as { directory: string }
    await backup(source, 'verify', directory)
    await expect(backup(source, 'restore', directory, '--confirm-stopped')).rejects.toThrow('in use')
    await newDeck(phone, 'Written after snapshot', 'truncate,截断')
    const { port } = instance
    await instance.close()
    instance = undefined
    await backup(target, 'restore', directory, '--confirm-stopped')
    instance = await start(target, port)
    await phone.reload()
    await expect(phone.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await signIn(phone)
    await settings(phone)
    const recovered = (await exportLibrary(phone)).snapshot
    expect(comparable(recovered)).toEqual(comparable(snapshot))
    expect(recovered.reviewCards).toEqual(snapshot.reviewCards)
    await newDeck(phone, 'Written after restore', 'recovery,恢复')
    await instance.close()
    instance = await start(target, port)
    await phone.reload()
    await expect(phone.getByRole('heading', { name: 'recovery', exact: true })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await instance?.close()
    await rm(root, { recursive: true, force: true })
  }
})
