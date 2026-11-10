import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures'
import type { LibraryExport } from '../shared/contracts/library'

async function createDeck(page: Page, name: string) {
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
}

async function addWord(page: Page, term: string, meaning = '') {
  await page.getByRole('button', { name: 'Add word' }).click()
  await page.getByLabel('Term', { exact: true }).fill(term)
  await page.getByLabel('Meaning optional', { exact: true }).fill(meaning)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: term, exact: true })).toBeVisible()
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  const dialog = page.locator('.library-dialog:visible')
  if (await dialog.count()) {
    expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await dialog.evaluate((element) => element.clientWidth))
  }
}

test('edits, searches, removes, restores and archives on a 320px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/library')
  await createDeck(page, 'Computer English')
  await expectNoOverflow(page)
  await page.getByRole('button', { name: 'Edit deck' }).click()
  await page.getByLabel('Deck name').fill('Systems English')
  await page.getByLabel('Description optional').fill('计算机专业词汇')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name: 'Systems English' }).click()
  const deckUrl = page.url()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Systems English' })).toBeVisible()
  await addWord(page, 'Deadlock', '死锁')
  await addWord(page, 'WAL')
  await expectNoOverflow(page)

  const search = page.getByLabel('Search words or meanings')
  for (const query of ['DEAD', '死锁']) {
    await search.fill(query)
    await expect(page.getByRole('heading', { name: 'Deadlock', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'WAL', exact: true })).toHaveCount(0)
  }
  await search.fill('nonexistent')
  await expect(page.getByText('No words match this search')).toBeVisible()
  await search.clear()
  await page.getByRole('button', { name: 'Needs meaning' }).click()
  await expect(page.getByRole('heading', { name: 'WAL', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Deadlock', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'All words' }).click()

  const deadlock = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Deadlock', exact: true }) })
  await deadlock.getByRole('button', { name: 'Edit word' }).click()
  await expectNoOverflow(page)
  await page.getByLabel('Meaning optional', { exact: true }).fill('死锁，循环等待')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(deadlock.getByText('死锁，循环等待')).toBeVisible()
  await deadlock.getByRole('button', { name: 'Remove word' }).click()
  await page.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await expect(deadlock).toHaveCount(0)
  await page.getByRole('button', { name: 'Removed', exact: true }).click()
  await deadlock.getByRole('button', { name: 'Restore word' }).click()
  await expect(page.getByText('No removed words')).toBeVisible()
  await page.getByRole('link', { name: 'Back to Library' }).click()
  await page.getByRole('button', { name: 'Archive deck' }).click()
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await page.getByRole('button', { name: 'Archived decks' }).click()
  await expect(page.getByRole('link', { name: 'Systems English' })).toHaveAttribute('href', new URL(deckUrl).pathname)
  await page.getByRole('link', { name: 'Systems English' }).click()
  await expect(page.getByText('This deck is archived.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Restore deck' }).click()
  await expect(page.getByRole('button', { name: 'Add word' })).toBeVisible()
  await expect(page.getByText('2 words', { exact: true })).toBeVisible()
  await expectNoOverflow(page)
})

test('previews TXT and CSV, explicitly overwrites duplicates and downloads full JSON', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/library')
  await createDeck(page, 'Computer English')
  await page.getByRole('link', { name: 'Computer English' }).click()
  await page.getByRole('button', { name: 'Import words' }).click()
  const upload = page.getByLabel('Vocabulary file')
  await upload.setInputFiles({
    name: 'systems.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFWAL\t预写日志\r\ncopy-on-write\r\nwal\t重复\r\n'),
  })
  await expect(page.getByText('3 total · 3 valid · 1 duplicates · 0 invalid · 1 missing meanings')).toBeVisible()
  await expectNoOverflow(page)
  await page.getByRole('button', { name: 'Import 2 words' }).click()
  await expect(page.getByRole('heading', { name: 'copy-on-write' })).toBeVisible()

  await page.getByRole('button', { name: 'Import words' }).click()
  await upload.setInputFiles({
    name: 'systems.csv', mimeType: 'text/csv',
    buffer: Buffer.from('term,meaning,example\nwal,"日志, 持久化","First line\nSecond line"\nlock-free queue,无锁队列,\n'),
  })
  await expect(page.getByText('Already in deck')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import 1 word', exact: true })).toBeVisible()
  await expectNoOverflow(page)
  await page.getByText('Overwrite matching words in this deck').click()
  await page.getByRole('button', { name: 'Import 2 words' }).click()
  await expect(page.getByText('日志, 持久化')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'lock-free queue' })).toBeVisible()

  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'copy-on-write' }) })
    .getByRole('button', { name: 'Remove word' }).click()
  await page.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await page.getByRole('link', { name: 'Back to Library' }).click()
  await page.getByRole('button', { name: 'Archive deck' }).click()
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export library' }).click(),
  ])
  const exported: LibraryExport = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(exported).toMatchObject({
    format: 'lexyn-library', formatVersion: 4, metadata: { scope: 'library' },
    settings: { dailyNewWords: 10, timezone: 'UTC' },
    decks: [{ name: 'Computer English', archivedAt: expect.any(Number), revision: 2 }],
  })
  expect(exported.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ term: 'copy-on-write', deletedAt: expect.any(Number) }),
    expect.objectContaining({ term: 'wal', meaning: '日志, 持久化', example: 'First line\nSecond line', revision: 2 }),
  ]))
})

test('rejects offline writes and shares saved words with a separate browser profile', async ({ page, browser, baseURL }) => {
  await createDeck(page, 'Shared Systems')
  await page.getByRole('link', { name: 'Shared Systems' }).click()
  await page.getByRole('button', { name: 'Add word' }).click()
  await page.context().setOffline(true)
  await page.getByLabel('Term', { exact: true }).fill('vector clock')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.library-dialog').getByRole('alert')).toContainText('Could not reach the server')
  await expect(page.getByRole('heading', { name: 'vector clock' })).toHaveCount(0)
  const second = await browser.newContext({ baseURL })
  try {
    const other = await second.newPage()
    await other.goto(page.url())
    await signIn(other)
    await expect(other.getByText('This deck has no words yet')).toBeVisible()
    await page.context().setOffline(false)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'vector clock' })).toBeVisible()
    await other.reload()
    await expect(other.getByRole('heading', { name: 'vector clock' })).toBeVisible()
  } finally { await second.close() }
})
