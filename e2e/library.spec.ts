import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type Database from 'better-sqlite3'
import { navigateFromMenu, expect, libraryAction, fillMeaning, signIn, test, writeStudy } from './fixtures'
import type { LibraryExport } from '../shared/contracts/library'
import type { Entry } from '../shared/domain/library'

async function createDeck(page: Page, name: string) {
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
}

async function addWord(page: Page, term: string, meaning = '') {
  await libraryAction(page, 'Add word', 'Deck options')
  await page.getByLabel('Term', { exact: true }).fill(term)
  if (meaning) await fillMeaning(page, meaning)
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

function storedEntry(db: Database.Database, term: string) {
  const row = db.prepare('SELECT body FROM entries WHERE active_term = ?').get(term.toLowerCase()) as { body: string } | undefined
  return row ? JSON.parse(row.body) as Entry : undefined
}

test('filters the word list and advances the listening queue without recording practice', async ({ page, backend }) => {
  await page.addInitScript(() => {
    window.lexynAudio = { plays: [], pauses: 0, revoked: [] }
    let current: HTMLMediaElement
    HTMLMediaElement.prototype.play = async function () {
      current = this
      window.lexynAudio.plays.push({ url: this.src, rate: this.playbackRate })
    }
    HTMLMediaElement.prototype.pause = function () { window.lexynAudio.pauses++ }
    window.addEventListener('finish-test-audio', () => current?.dispatchEvent(new Event('ended')))
  })
  await page.goto('/library')
  await createDeck(page, 'Listening words')
  const href = await page.getByRole('link', { name: 'Listening words' }).getAttribute('href')
  const deckId = href!.split('/').at(-1)!
  for (const [term, meaning] of [['zebra', '斑马'], ['quorum', '法定人数']]) {
    expect((await writeStudy(page, 'library/create-entry', [deckId, { term, meaning }])).ok()).toBe(true)
  }
  await page.goto(href + '/words')
  await page.locator('.spell-word-options summary').click()
  await page.getByRole('button', { name: /^Learned/ }).click()
  await expect(page.getByText('No words match this filter.')).toBeVisible()
  await page.getByRole('button', { name: /^Not yet learned/ }).click()
  await page.getByLabel('Show meanings').check()
  await page.getByLabel('Sort words').selectOption('alphabetical')
  await expect(page.getByText('法定人数')).toBeVisible()
  await page.locator('.spell-word-options summary').click()
  await page.getByRole('button', { name: 'Listen to words' }).click()
  await expect(page.getByRole('button', { name: 'Studied today 0' })).toBeDisabled()
  await page.getByRole('button', { name: 'Current list 2' }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.lexynAudio.plays.length)).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event('finish-test-audio')))
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.lexynAudio.plays.length)).toBe(2)
  await page.getByRole('button', { name: 'Pause pronunciation' }).click()
  await expect(page.getByRole('button', { name: 'Play pronunciation' })).toBeVisible()
  await page.getByRole('button', { name: 'Open word list' }).click()
  await expect(page.getByRole('link', { name: 'quorum', exact: true })).toBeVisible()
  expect((await writeStudy(page, 'library/create-entry', [deckId, { term: 'apple', meaning: '苹果' }])).ok()).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: 'Listen to words' }).click()
  await page.getByRole('button', { name: 'Resume playback' }).click()
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await expect(page.getByText('3 / 3', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.lexynAudio.plays.length)).toBe(1)
  const extraWords = Array.from({ length: 58 }, (_, index) => {
    const term = 'middle-' + String(index).padStart(2, '0')
    return { input: { term, meaning: '' }, normalizedTerm: term }
  })
  expect((await writeStudy(page, 'library/import', [deckId, extraWords, 'skip'])).ok()).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: 'Listen to words' }).click()
  await page.getByRole('button', { name: 'Resume playback' }).click()
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.lexynAudio.plays.length)).toBe(1)
  const queueButton = page.getByRole('button', { name: 'Playback queue', exact: true })
  await queueButton.click()
  const queue = page.getByRole('dialog', { name: 'Playback queue (61)' })
  await expect(queue.getByRole('button', { name: 'zebra' })).toHaveAttribute('aria-current', 'true')
  await queue.getByRole('button', { name: 'Previous', exact: true }).click()
  await queue.getByRole('button', { name: 'apple', exact: true }).click()
  await expect(queue).toBeHidden()
  await expect(page.getByRole('heading', { name: 'apple' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.lexynAudio.plays.length)).toBe(2)
  await queueButton.click()
  await expect(queue.getByRole('button', { name: 'apple' })).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')
  await expect(queueButton).toBeFocused()
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
})

test('shows the current book dashboard, restores its last list and falls back after archive', async ({ page }) => {
  await page.goto('/')
  await createDeck(page, 'Current vocabulary')
  await createDeck(page, 'Other vocabulary')
  const book = page.getByRole('article').filter({ hasText: 'Current vocabulary' })
  await book.getByRole('button', { name: 'Set as current book' }).click()
  await libraryAction(page, 'Import words', 'Deck options')
  await page.getByLabel('Words per list').fill('1')
  await page.getByLabel('Vocabulary file').setInputFiles({
    name: 'reader.txt', mimeType: 'text/plain', buffer: Buffer.from('zebra\t斑马\nquorum\t法定人数'),
  })
  await page.getByRole('button', { name: 'Import 2 words' }).click()
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await page.getByRole('button', { name: 'List 01', exact: true }).click()
  await page.getByRole('button', { name: /^List 02/ }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()

  await page.goto('/')
  await expect(page.locator('.spell-ring-label strong')).toHaveText('2')
  await page.setViewportSize({ width: 320, height: 740 })
  await expectNoOverflow(page)
  await page.getByRole('link', { name: 'Add word', exact: true }).click()
  await expect(page.getByLabel('Term', { exact: true })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'Open word list' }).click()
  await expect(page.getByRole('heading', { name: 'My words (2)' })).toBeVisible()
  await page.getByRole('link', { name: 'quorum', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await expect(page.getByText('法定人数')).toBeVisible()
  await expect(page.getByText('No learning or review history yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Open word list' }).click()
  await page.getByRole('link', { name: 'Study lists' }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'zebra' })).toHaveCount(0)
  await page.goto('/')
  const search = page.getByRole('searchbox', { name: 'Search words or meanings' })
  await search.fill('zebra')
  await search.press('Enter')
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'quorum' })).toHaveCount(0)
  await page.goto('/')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page).toHaveURL(/\/learn\/read\?/)
  const reading = page.locator('.spell-reading')
  const term = await reading.locator('.learn-term').innerText()
  await expect(reading.getByRole('textbox')).toHaveCount(0)
  const sessionId = new URL(page.url()).searchParams.get('session')
  await reading.getByRole('link', { name: 'Start spelling' }).click()
  await expect(page).toHaveURL(/\/learn\/spell\?/)
  expect(new URL(page.url()).searchParams.get('session')).toBe(sessionId)
  const practice = page.locator('.spell-practice')
  const answer = practice.getByRole('textbox', { name: 'Copy the word' })
  await expect(answer).toBeFocused()
  const keyboard = practice.getByRole('group', { name: 'On-screen keyboard' })
  const keyboardToggle = practice.getByRole('button', { name: 'On-screen keyboard' })
  await keyboardToggle.click()
  await expect(keyboard).toBeHidden()
  await keyboardToggle.click()
  await keyboard.getByRole('button', { name: term[0], exact: true }).click()
  await expect(answer).toHaveValue(term[0])
  await expect(practice.locator('.spell-letter-slots')).toHaveText(term[0])
  await expectNoOverflow(page)
  await answer.fill(term)
  await practice.getByRole('button', { name: 'Check spelling' }).click()
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page).toHaveURL(/\/learn\/read\?/)
  await page.goto('/')
  await page.getByRole('link', { name: 'Open word list' }).click()
  await page.getByRole('button', { name: 'Listen to words' }).click()
  await expect(page.getByRole('button', { name: 'Studied today 1' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Studied this week 1' })).toBeEnabled()
  await page.goto('/')
  await page.getByRole('link', { name: 'Study activity' }).click()
  await expect(page.locator('.spell-streak strong')).toHaveText('1')
  await expect(page.locator('.spell-calendar time[aria-current="date"]')).toHaveClass('day-studied')
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.locator('.spell-calendar time[aria-current="date"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.locator('.spell-calendar time[aria-current="date"]')).toBeVisible()
  await expectNoOverflow(page)
  await navigateFromMenu(page, 'Library')
  await expect(page).toHaveURL(/\/library$/)
  await expect(book.getByText('Current book', { exact: true })).toBeVisible()
  await libraryAction(book, 'Archive deck', 'Book options')
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(book).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Other vocabulary' })).toBeVisible()
  await expect(page).toHaveURL(/\/study$/)
})

test('keeps edit drafts through temporary spelling changes and clears word-bound data only on a real rename', async ({ page, backend }) => {
  await page.goto('/library')
  await createDeck(page, 'Term editing')
  await page.getByRole('link', { name: 'Term editing', exact: true }).click()
  const deckId = new URL(page.url()).pathname.split('/').at(-1)!
  const dictionaryMeaning = { senses: [
    { partOfSpeech: 'n.', definitions: ['线程', '线索'], source: 'manual' as const },
    { partOfSpeech: 'vt.', definitions: ['穿线'], source: 'manual' as const },
  ] }
  const dictionaryReference = { sourceWord: 'thread', sourceRevision: 'fixture', translation: 'n. 原始词典释义',
    definition: 'a thin cord', partOfSpeech: 'n.', phonetic: 'θred' }
  const phonetics = { british: '/θred/', american: '/θrɛd/', unspecified: 'thred' }
  const created = await writeStudy(page, 'library/create-entry', [deckId, {
    term: 'thread', meaning: 'n. 线程；线索\nvt. 穿线', dictionaryMeaning, dictionaryReference, phonetics,
    phonetic: 'thred', example: 'Legacy example.', note: 'Legacy note.', pronunciationOverride: 'th red',
  }])
  expect(created.ok()).toBe(true)
  const entry = ((await created.json()).data) as Entry
  await page.reload()

  const article = () => page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'thread', exact: true }) })
  await libraryAction(article(), 'Edit word')
  const term = page.getByLabel('Term', { exact: true })
  const definition = page.getByLabel('Definition 1', { exact: true }).first()
  await term.fill('threads')
  await expect(definition).toHaveValue('线程')
  await expect(page.getByLabel('British phonetic')).toHaveValue('/θred/')
  await term.fill('thread')
  await expect(definition).toHaveValue('线程')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => storedEntry(backend.db, 'thread')?.revision).toBe(entry.revision + 1)
  const savedOriginal = storedEntry(backend.db, 'thread')!
  expect(savedOriginal).toMatchObject({ meaning: entry.meaning, dictionaryMeaning, dictionaryReference, phonetics,
    phonetic: 'thred', example: 'Legacy example.', note: 'Legacy note.', pronunciationOverride: 'th red' })

  await libraryAction(article(), 'Edit word')
  await fillMeaning(page, '未保存的释义草稿')
  await term.fill('threads')
  await term.fill('thread')
  await expect(definition).toHaveValue('未保存的释义草稿')
  await expect(page.getByLabel('American phonetic')).toHaveValue('/θrɛd/')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(storedEntry(backend.db, 'thread')).toEqual(savedOriginal)

  await libraryAction(article(), 'Edit word')
  await fillMeaning(page, '未保存的释义草稿')
  await term.fill('threads')
  await term.fill('thread')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => storedEntry(backend.db, 'thread')?.revision).toBe(savedOriginal.revision + 1)
  const edited = storedEntry(backend.db, 'thread')!
  expect(edited).toMatchObject({ meaning: 'n. 未保存的释义草稿；线索\nvt. 穿线', dictionaryReference, phonetics,
    example: 'Legacy example.', note: 'Legacy note.' })

  await libraryAction(article(), 'Edit word')
  await term.fill('queue')
  await expect(page.getByText('Saving a different spelling clears its meaning and phonetics while keeping review history and schedule.'))
    .toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'queue', exact: true })).toBeVisible()
  const renamed = storedEntry(backend.db, 'queue')!
  expect(renamed).toMatchObject({ term: 'queue', meaning: '', revision: edited.revision + 1, termChangedAt: expect.any(Number) })
  expect(renamed.dictionaryMeaning).toBeUndefined()
  expect(renamed.dictionaryReference).toBeUndefined()
  expect(renamed.phonetics).toBeUndefined()
  expect(renamed.phonetic).toBeUndefined()
  expect(renamed.pronunciationOverride).toBeUndefined()

  await libraryAction(page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'queue', exact: true }) }), 'Edit word')
  await page.getByLabel('Term', { exact: true }).fill('queues')
  await page.getByRole('button', { name: 'Save and optimize with AI', exact: true }).click()
  await expect(page.getByLabel('Definition 1', { exact: true })).toHaveValue('队列')
  await expect(page.getByText('Saving a different spelling clears its meaning and phonetics while keeping review history and schedule.'))
    .toHaveCount(0)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect(storedEntry(backend.db, 'queues')?.meaning).toBe('n. 队列')
  const currentQueue = storedEntry(backend.db, 'queues')!

  await libraryAction(page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'queues', exact: true }) }), 'Edit word')
  const newer = await writeStudy(page, 'library/update-entry', [deckId, currentQueue.id, {
    term: 'queues', meaning: '远端释义', dictionaryMeaning: { senses: [
      { partOfSpeech: '', definitions: ['远端释义'], source: 'manual' },
    ] },
  }, currentQueue.revision])
  expect(newer.ok()).toBe(true)
  await fillMeaning(page, '本地旧草稿')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.library-dialog').getByRole('alert')).toBeVisible()
  expect(storedEntry(backend.db, 'queues')?.meaning).toBe('远端释义')
})

test('saving an ECDICT-only word without a final meaning preserves its immutable reference', async ({ page, backend }) => {
  await page.goto('/library')
  await createDeck(page, 'Dictionary reference')
  await page.getByRole('link', { name: 'Dictionary reference', exact: true }).click()
  const deckId = new URL(page.url()).pathname.split('/').at(-1)!
  const dictionaryMeaning = { sourceWord: 'thread', sourceRevision: 'fixture', rawTranslation: 'n. 原始词典释义',
    senses: [{ partOfSpeech: 'n.', definitions: ['线程'], source: 'ecdict' as const }] }
  const dictionaryReference = { sourceWord: 'thread', sourceRevision: 'fixture', translation: 'n. 原始词典释义',
    definition: 'a thin cord', partOfSpeech: 'n.', phonetic: 'θred' }
  const response = await writeStudy(page, 'library/create-entry', [deckId, {
    term: 'thread', meaning: '', dictionaryMeaning, dictionaryReference, phonetics: { unspecified: 'θred' },
  }])
  expect(response.ok()).toBe(true)
  const entry = (await response.json()).data as Entry
  await page.reload()
  await libraryAction(page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'thread', exact: true }) }), 'Edit word')
  await page.getByLabel('Term', { exact: true }).fill('threads')
  await page.getByLabel('Term', { exact: true }).fill('thread')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => storedEntry(backend.db, 'thread')?.revision).toBe(entry.revision + 1)
  expect(storedEntry(backend.db, 'thread')).toMatchObject({
    meaning: '', dictionaryMeaning, dictionaryReference, phonetics: { unspecified: 'θred' },
  })
})

test('edits, searches, removes, restores and archives on a 320px viewport', async ({ page, backend }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/library')
  await createDeck(page, 'Computer English')
  await expectNoOverflow(page)
  await libraryAction(page, 'Edit deck', 'Book options')
  await page.getByLabel('Deck name').fill('Systems English')
  await page.getByLabel('Description optional').fill('计算机专业词汇')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name: 'Systems English' }).click()
  const deckUrl = page.url()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Systems English' })).toBeVisible()
  await addWord(page, 'Deadlock', '死锁')
  await addWord(page, 'WAL')
  await expect.poll(() => backend.db.prepare("SELECT revision FROM entries WHERE active_term = 'deadlock'").pluck().get()).toBe(2)
  await page.reload()
  await expectNoOverflow(page)

  await page.getByRole('button', { name: 'Search and filters' }).click()
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
  await libraryAction(deadlock, 'Edit word')
  await expectNoOverflow(page)
  await fillMeaning(page, '死锁，循环等待')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(deadlock.getByText('死锁，循环等待')).toBeVisible()
  await libraryAction(deadlock, 'Remove word')
  await page.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await expect(deadlock).toHaveCount(0)
  await page.getByRole('button', { name: 'Removed', exact: true }).click()
  await libraryAction(deadlock, 'Restore word')
  await expect(page.getByText('No removed words')).toBeVisible()
  await navigateFromMenu(page, 'Library')
  await libraryAction(page, 'Archive deck', 'Book options')
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await libraryAction(page, 'Archived decks', 'Library options')
  await expect(page.getByRole('link', { name: 'Systems English' })).toHaveAttribute('href', new URL(deckUrl).pathname)
  await page.getByRole('link', { name: 'Systems English' }).click()
  await expect(page.getByText('This deck is archived.', { exact: false })).toBeVisible()
  await libraryAction(page, 'Restore deck', 'Deck options')
  await page.locator('.app-menu > summary').click()
  await expect(page.getByRole('button', { name: 'Add word' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Words', exact: true }).getByRole('listitem')).toHaveCount(2)
  await expectNoOverflow(page)
})

test('previews TXT and CSV, explicitly overwrites duplicates and downloads full JSON', async ({ page, backend }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/library')
  await createDeck(page, 'Computer English')
  await page.getByRole('link', { name: 'Computer English' }).click()
  await libraryAction(page, 'Import words', 'Deck options')
  const upload = page.getByLabel('Vocabulary file')
  await upload.setInputFiles({
    name: 'systems.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFWAL\t预写日志\r\ncopy-on-write\r\nwal\t重复\r\n'),
  })
  await expect(page.getByText('3 total · 3 valid · 1 duplicates · 0 invalid · 1 missing meanings')).toBeVisible()
  await expectNoOverflow(page)
  await page.getByRole('button', { name: 'Import 2 words' }).click()
  await expect(page.getByRole('heading', { name: 'copy-on-write' })).toBeVisible()
  const deckId = new URL(page.url()).pathname.split('/').at(-1)!
  const wal = storedEntry(backend.db, 'wal')!
  const historicalFields = await writeStudy(page, 'library/update-entry', [deckId, wal.id, {
    term: 'wal', meaning: wal.meaning, example: 'Historical example.', note: 'Historical note.',
  }, wal.revision])
  expect(historicalFields.ok()).toBe(true)

  await libraryAction(page, 'Import words', 'Deck options')
  await upload.setInputFiles({
    name: 'systems.csv', mimeType: 'text/csv',
    buffer: Buffer.from('term,meaning,example,note\nwal,"日志, 持久化","First line\nSecond line",Do not import\nlock-free queue,无锁队列,,Do not import\n'),
  })
  await expect(page.getByText('Already in deck')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import 1 word', exact: true })).toBeVisible()
  await expect(page.locator('.library-dialog').getByText('Example', { exact: true })).toHaveCount(0)
  await expect(page.locator('.library-dialog').getByText('Note', { exact: true })).toHaveCount(0)
  await expectNoOverflow(page)
  await page.getByText('Overwrite matching words in this deck').click()
  await page.getByRole('button', { name: 'Import 2 words' }).click()
  await expect(page.getByRole('list', { name: 'Words', exact: true }).getByText('日志, 持久化', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'lock-free queue' })).toBeVisible()

  await libraryAction(page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'copy-on-write' }) }), 'Remove word')
  await page.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await navigateFromMenu(page, 'Library')
  await libraryAction(page, 'Archive deck', 'Book options')
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    libraryAction(page, 'Export library', 'Library options'),
  ])
  const exported: LibraryExport = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(exported).toMatchObject({
    format: 'lexyn-library', formatVersion: 6, metadata: { scope: 'library' },
    settings: { dailyNewWords: 10, timezone: 'UTC' },
    decks: [{ name: 'Computer English', archivedAt: expect.any(Number), revision: 2 }],
  })
  expect(exported.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ term: 'copy-on-write', deletedAt: expect.any(Number) }),
    expect.objectContaining({ term: 'wal', meaning: '日志, 持久化', example: 'Historical example.', note: 'Historical note.', revision: 3 }),
  ]))
})

test('rejects offline writes and shares saved words with a separate browser profile', async ({ page, browser, baseURL }) => {
  await createDeck(page, 'Shared Systems')
  await page.getByRole('link', { name: 'Shared Systems' }).click()
  await libraryAction(page, 'Add word', 'Deck options')
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

test('browses persistent study lists, resumes within a selected list and continues to the next', async ({ page, backend }) => {
  await page.goto('/library')
  await createDeck(page, 'Study chapters')
  await page.getByRole('link', { name: 'Study chapters', exact: true }).click()
  const deckPath = new URL(page.url()).pathname
  await libraryAction(page, 'Import words', 'Deck options')
  await page.getByLabel('Words per list').fill('1')
  await page.getByLabel('Vocabulary file').setInputFiles({
    name: 'chapters.txt', mimeType: 'text/plain', buffer: Buffer.from('zebra\t斑马\nquorum\t法定人数\nthread\t线程'),
  })
  await page.getByRole('button', { name: 'Import 3 words' }).click()
  const picker = page.getByRole('combobox', { name: 'Study list', exact: true })
  await expect(picker.locator('option')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'quorum' })).toHaveCount(0)
  const firstWord = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'zebra', exact: true }) })
  await firstWord.getByRole('button', { name: 'Hide meaning', exact: true }).click()
  await expect(firstWord.getByRole('button', { name: 'Show meaning', exact: true })).toBeVisible()
  await expect(firstWord.getByText('斑马', { exact: true })).toHaveCount(0)
  await firstWord.getByRole('button', { name: 'Show meaning', exact: true }).click()
  await expect(firstWord.getByText('斑马', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Next list' }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'zebra' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await page.goto(deckPath)
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  const openLists = () => page.getByRole('button', { name: 'Choose a study list', exact: true }).click()
  await openLists()
  await expect(page.getByText('0 of 3 lists complete')).toBeVisible()
  await page.keyboard.press('Escape')

  await libraryAction(page, 'Rename list', 'Deck options')
  await page.getByLabel('List name', { exact: true }).fill('Consensus')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Consensus' })).toBeVisible()
  const selectedList = await picker.inputValue()
  await page.getByRole('link', { name: 'Start learning' }).click()
  await expect(page.getByRole('link', { name: 'Consensus' })).toBeVisible()
  await page.getByRole('button', { name: 'Learn 1 new word' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('quorum')
  await answer.press('Enter')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText('Session paused.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to study list' }).click()
  await expect(picker).toHaveValue(selectedList)
  await page.getByRole('link', { name: 'Continue learning' }).click()
  await page.getByRole('button', { name: 'Continue session' }).click()
  await expect(answer).toHaveValue('quorum')
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByRole('link', { name: 'Return to study list' })).toBeVisible()
  await page.getByRole('link', { name: 'Next list · List 03' }).click()
  await expect(page.getByRole('heading', { name: 'thread' })).toBeVisible()
  await openLists()
  await expect(page.getByText('1 of 3 lists complete')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Previous list' }).click()
  await expect(picker).toHaveValue(selectedList)
  await openLists()
  await expect(page.getByRole('button', { name: /Consensus.*List complete.*1 of 1 words learned/ })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(1)
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
  await page.getByRole('link', { name: 'Learning plan' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible()
  await expect(page.locator('.plan-table')).toContainText('Consensus')
})
