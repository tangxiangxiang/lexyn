import { defaultWordbookFilters } from '../shared/contracts/wordbooks'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importEcdictCsv } from '../server/dictionary/import'
import type { Page } from '@playwright/test'
import type Database from 'better-sqlite3'
import { openStudyLists, expect, libraryAction, fillMeaning, signIn, studyRequest, test, wordbookLink, writeStudy } from './fixtures'
import type { LibraryExport } from '../shared/contracts/library'
import type { Entry } from '../shared/domain/library'
import { trackPlayback } from './mock-speech'

async function createDeck(page: Page, name: string) {
  await page.getByRole('button', { name: 'Create a wordbook' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(wordbookLink(page, name)).toBeVisible()
}

async function addWord(page: Page, term: string, meaning = '') {
  await libraryAction(page, 'Add word', 'Deck options')
  await page.getByLabel('Term', { exact: true }).fill(term)
  if (meaning) await fillMeaning(page, meaning)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: term, exact: true })).toBeVisible()
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  const dialog = page.locator('.library-dialog:visible')
  if (await dialog.count()) {
    expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await dialog.evaluate((element) => element.clientWidth))
  }
}

function storedEntry(db: Database.Database, term: string) {
  const row = db.prepare('SELECT body FROM entries WHERE active_term = ?').get(term.toLowerCase()) as { body: string } | undefined
  return row ? JSON.parse(row.body) as Entry : undefined
}

test('chooses a built-in book from the actual dictionary and respects the composition filter', async ({ page, backend }) => {
  const file = join(backend.directory, 'dictionary.csv')
  await writeFile(file, [
    'word,phonetic,definition,translation,pos,tag,bnc,frq,exchange,collins,oxford',
    'signal,ˈsɪɡnəl,signal,n. 信号,n,cet4 gk,42,50,,4,1',
    'thread,θred,thread,n. 线程,n,cet4,100,0,,2,',
  ].join('\n'))
  await importEcdictCsv(backend.directory, file, 'e2e')

  await page.getByRole('link', { name: 'Built-in wordbooks' }).click()
  await expect(page.getByRole('button', { name: 'Japanese' })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Primary school/ })).toBeDisabled()
  await page.getByRole('button', { name: 'College English Test Band 4 2 words' }).click()
  await page.getByText('Wordbook filters', { exact: true }).click()
  await expect(page.getByText('CEFR sources have not been installed.')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'A1', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: '4 ★' }).check()
  await expect(page.locator('.builtin-book-detail-count')).toHaveText('1 word')
  await page.getByRole('checkbox', { name: '4 ★' }).uncheck()
  await expect(page.locator('.builtin-book-detail-count')).toHaveText('2 words')
  const bandFour = page.getByRole('button', { name: 'College English Test Band 4 2 words' })
  await expect(bandFour).toHaveAttribute('aria-pressed', 'true')
  await bandFour.click()
  await expect(bandFour).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.builtin-book-detail-count')).toHaveText('1 word')
  for (const width of [320, 375, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    await expectNoOverflow(page)
  }
  await page.getByRole('button', { name: 'Choose', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(backend.db.prepare('SELECT count(*) FROM decks').pluck().get()).toBe(0)
  await page.getByRole('button', { name: 'Choose', exact: true }).click()
  await page.getByRole('button', { name: '20', exact: true }).click()
  await page.getByRole('button', { name: 'Install wordbook', exact: true }).click()
  await expect(page.getByRole('link', { name: 'signal', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'thread', exact: true })).toHaveCount(0)
  const preview = await studyRequest(page, 'library/builtin-book', ['cet4', ['cet4'], defaultWordbookFilters, 0, 20])
  const { data: selection } = await preview.json()
  const [first, second] = await Promise.all([
    writeStudy(page, 'library/create-builtin-book', ['cet4', ['cet4'], defaultWordbookFilters, 50, selection.selection]),
    writeStudy(page, 'library/create-builtin-book', ['cet4', ['cet4'], defaultWordbookFilters, 30, selection.selection]),
  ])
  for (const response of [first, second]) {
    expect(response.ok()).toBe(true)
    expect((await response.json()).data).toMatchObject({ addedCount: 0, alreadyAdded: true })
  }
  expect(backend.db.prepare('SELECT count(*) FROM decks').pluck().get()).toBe(1)
  expect(backend.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(1)
  expect(backend.db.prepare("SELECT json_extract(body, '$.listSize') FROM decks").pluck().get()).toBe(20)
  expect(backend.vocabulary.requests).toEqual([])
  await page.goto('/study')
  await expect(page.getByRole('button', { name: 'Words to learn 1', exact: true })).toBeVisible()
})

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
  const deckId = href!.split('/').at(-2)!
  for (const [term, meaning] of [['zebra', '斑马'], ['quorum', '法定人数']]) {
    expect((await writeStudy(page, 'library/create-entry', [deckId, { term, meaning }])).ok()).toBe(true)
  }
  await page.goto(href!)
  await page.locator('.spell-word-options summary').click()
  await page.getByRole('button', { name: /^Learned/ }).click()
  await expect(page.getByText('No words match this filter.')).toBeVisible()
  await page.getByRole('button', { name: /^Not yet learned/ }).click()
  await page.getByLabel('Show meanings').check()
  await page.getByLabel('Sort words').selectOption('alphabetical')
  await expect(page.getByText('法定人数')).toBeVisible()
  const showSpellings = page.getByLabel('Show spellings')
  await showSpellings.uncheck()
  await expect(page.getByRole('link', { name: 'quorum', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '法定人数', exact: true })).toBeVisible()
  await showSpellings.check()
  await expect(page.getByRole('link', { name: 'quorum', exact: true })).toBeVisible()
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

test('studies from the current book, restores its last list and preserves progress when switching books', async ({ page, backend }) => {
  await trackPlayback(page)
  await page.goto('/')
  await createDeck(page, 'Current vocabulary')
  await createDeck(page, 'Other vocabulary')
  const book = page.getByRole('article').filter({ hasText: 'Current vocabulary' })
  await libraryAction(book, 'Set as current book', 'Book options')
  await page.goto('/library')
  await openStudyLists(page, 'Current vocabulary')
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
  await expect(page.locator('.spell-ring')).toHaveCount(1)
  await page.getByRole('button', { name: 'Words to learn 2' }).press('Enter')
  await expect(page.getByRole('button', { name: 'Words to learn 2' })).toHaveAttribute('aria-pressed', 'true')
  const review = page.getByRole('button', { name: 'Words to review 0', exact: true })
  await review.press('Space')
  await expect(review).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.spell-ring-label')).toContainText('Words to review')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('No study items are ready right now.')
  await expect(page).toHaveURL(/\/study$/)
  await page.locator('.spell-ring-label').click()
  await expect(page.locator('.spell-ring-label')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.spell-ring-label')).toContainText('Words to study')
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('max', '2')
  await expect(page.getByRole('link', { name: /^My books/ })).toHaveText(/My books\s*2/)
  const settings = page.locator('.settings-page')
  const layout = await settings.boundingBox()
  expect(layout).not.toBeNull()
  expect(Math.abs(layout!.x * 2 + layout!.width - page.viewportSize()!.width)).toBeLessThan(2)
  await page.setViewportSize({ width: 320, height: 740 })
  await expectNoOverflow(page)
  await page.getByRole('link', { name: 'Reading settings' }).click()
  await expect(page.getByRole('heading', { name: 'Reading settings' })).toBeVisible()
  await expectNoOverflow(page)
  await page.getByRole('link', { name: 'Close' }).click()
  await expect(page.getByRole('link', { name: /^My books/ })).toBeVisible()
  await page.getByRole('link', { name: 'Import words' }).click()
  await expect(page.getByLabel('Vocabulary file')).toBeVisible()
  await page.goto('/')
  await page.setViewportSize({ width: 320, height: 740 })
  await expectNoOverflow(page)
  await page.getByRole('link', { name: 'Add word', exact: true }).click()
  await expect(page.getByLabel('Term', { exact: true })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'Open word list' }).click()
  await expect(page.getByRole('heading', { name: 'My words (2)' })).toBeAttached()
  await page.getByRole('link', { name: 'quorum', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await expect(page.getByText('法定人数')).toBeVisible()
  await expect(page.getByText('No learning or review history yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Open word list' }).click()
  await page.getByLabel('Word list options').click()
  await page.getByRole('link', { name: 'Study lists' }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'zebra' })).toHaveCount(0)
  await page.goto('/')
  const search = page.getByRole('searchbox', { name: 'Search words or meanings' })
  await search.fill('法定人数')
  const liveResults = page.getByRole('region', { name: 'Search results' })
  await expect(liveResults.getByRole('link', { name: /quorum/ })).toBeVisible()
  await expect(page).toHaveURL(/\/study$/)
  await liveResults.getByRole('link', { name: /quorum/ }).click()
  await expect(page.getByRole('heading', { name: 'quorum' })).toBeVisible()
  await page.goto('/')
  const searchAgain = page.getByRole('searchbox', { name: 'Search words or meanings' })
  await searchAgain.fill('zebra')
  await searchAgain.press('Enter')
  await expect(page.getByRole('heading', { name: 'zebra' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'quorum' })).toHaveCount(0)
  await page.goto('/')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page).toHaveURL(/\/learn\/read\?/)
  const reading = page.locator('.spell-reading')
  const term = await reading.locator('.learn-term').innerText()
  await expect(reading.getByText(term === 'zebra' ? '斑马' : '法定人数', { exact: true })).toBeVisible()
  await reading.getByRole('button', { name: 'Play pronunciation' }).click()
  await expect(reading.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  expect(backend.speech.requests.map(({ text }) => text)).toEqual([term])
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
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
  const tiles = practice.getByRole('group', { name: 'Your spelling so far' })
  await expect(tiles).toHaveText(term[0])
  const wrong = term[1].toLowerCase() === 'x' ? 'y' : 'x'
  await keyboard.getByRole('button', { name: wrong, exact: true }).click()
  await expect(tiles.locator('.spell-answer-tile-incorrect')).toHaveText(wrong)
  await expect(tiles).toHaveCount(0)
  await expect(answer).toHaveValue('')
  await expect(answer).toBeEditable()
  await expectNoOverflow(page)
  await answer.pressSequentially(term)
  await expect(practice.getByRole('heading', { name: term, exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/\/learn\/spell\?/)
  expect(backend.db.prepare("SELECT json_extract(body, '$.firstTryCorrect') FROM practice_events").pluck().get()).toBe(0)
  await page.goto('/')
  const firstRecall = page.getByRole('button', { name: 'Words to review 1', exact: true })
  await firstRecall.press('Enter')
  await expect(firstRecall).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.spell-ring-label strong')).toHaveText('1')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page).toHaveURL(/\/review\?deckId=/)
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
  await page.goto('/')
  await page.getByRole('link', { name: 'Open word list' }).click()
  await page.getByRole('button', { name: 'Listen to words' }).click()
  await expect(page.getByRole('button', { name: 'Studied today 1' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Studied this week 1' })).toBeEnabled()
  await page.goto('/')
  await page.getByRole('link', { name: 'Study activity' }).click()
  await expect(page.locator('.spell-streak strong')).toHaveText('1')
  await expect(page.locator('.spell-calendar button[aria-current="date"]')).toHaveClass('day-studied')
  await expect(page.locator('.activity-day-summary')).toContainText('1 new words · 0 review ratings')
  await page.locator('.spell-calendar button.day-studied').click()
  await expect(page.locator('.spell-calendar button.day-studied')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.locator('.spell-calendar button[aria-current="date"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.locator('.spell-calendar button[aria-current="date"]')).toBeVisible()
  await expectNoOverflow(page)
  await page.goto('/library')
  await wordbookLink(page, 'Other vocabulary').click()
  await page.getByRole('link', { name: 'Lexyn home' }).click()
  await expect(page.getByRole('link', { name: 'Open word list' })).toHaveAttribute('title', 'Other vocabulary')
  await expect(page.getByRole('button', { name: 'Words to learn 0' })).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/library')
  await wordbookLink(page, 'Current vocabulary').click()
  await page.getByRole('link', { name: 'Lexyn home' }).click()
  await expect(page.getByRole('link', { name: 'Open word list' })).toHaveAttribute('title', 'Current vocabulary')
  await expect(page.getByRole('button', { name: 'Words to review 1' })).toBeVisible()
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(1)

  await page.goto('/library')
  await expect(page).toHaveURL(/\/library$/)
  await expect(page.getByRole('heading', { name: 'Current book', exact: true })).toBeVisible()
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
  await openStudyLists(page, 'Term editing')
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
  await openStudyLists(page, 'Dictionary reference')
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
  await openStudyLists(page, 'Systems English')
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
  await page.goto('/library')
  await libraryAction(page, 'Archive deck', 'Book options')
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await libraryAction(page, 'Archived decks', 'Page actions')
  await expect(page.getByRole('link', { name: 'Systems English' })).toHaveAttribute('href', new URL(deckUrl).pathname + '/words')
  await openStudyLists(page, 'Systems English')
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
  await openStudyLists(page, 'Computer English')
  await libraryAction(page, 'Import words', 'Deck options')
  const upload = page.getByLabel('Vocabulary file')
  await upload.setInputFiles({
    name: 'systems.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFWal\t预写日志\r\ncopy-on-write\r\nwal\t重复\r\n'),
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
  await page.goto('/library')
  await libraryAction(page, 'Archive deck', 'Book options')
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    libraryAction(page, 'Export library', 'Page actions'),
  ])
  const exported: LibraryExport = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(exported).toMatchObject({
    format: 'lexyn-library', formatVersion: 9, metadata: { scope: 'library' },
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
  await openStudyLists(page, 'Shared Systems')
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
  await openStudyLists(page, 'Study chapters')
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
  await page.getByRole('link', { name: 'Start spelling' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('qux')
  await expect(answer).toHaveValue('')
  await page.getByLabel('Session options').click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText('Session paused.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to study list' }).click()
  await expect(picker).toHaveValue(selectedList)
  await page.getByRole('link', { name: 'Continue learning' }).click()
  await page.getByRole('button', { name: 'Continue session' }).click()
  await expect(answer).toHaveValue('')
  await answer.fill('quorum')
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
