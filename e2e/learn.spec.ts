import type { Page } from '@playwright/test'
import { expect, fillMeaning, test, writeStudy } from './fixtures'
import type { LearnSession, PracticeEvent } from '../shared/domain/learning'
import type Database from 'better-sqlite3'

import { trackPlayback } from './mock-speech'

interface PracticeRecords {
  practice_events: PracticeEvent
  learn_sessions: LearnSession
}

function records<Table extends keyof PracticeRecords>(db: Database.Database, table: Table): PracticeRecords[Table][] {
  return (db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[]).map(({ body }) => JSON.parse(body))
}

async function makeDeckWithWords(page: Page, spellingHints = false) {
  await page.goto('/library')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill('Learn Systems')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name: 'Learn Systems' }).click()
  for (const [term, meaning] of [['concurrency', '并发'], ['deadlock', '死锁']]) {
    await page.getByRole('button', { name: 'Add word' }).click()
    await page.getByLabel('Term', { exact: true }).fill(term)
    await fillMeaning(page, spellingHints ? term + ' ' + meaning : meaning)
    if (spellingHints) {
      await page.getByLabel('Generic IPA', { exact: true }).fill(term)
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: term })).toBeVisible()
  }
}

test('learns a new word, retries a misspelling, resumes after reload and persists server practice history', async ({ page, backend }) => {
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency' })).toBeVisible()

  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrncy')
  await page.getByRole('button', { name: 'Check spelling' }).click()
  await expect(page.locator('.learn-practice-area [role="alert"]')).toContainText('Not quite')
  await expect(answer).toHaveValue('concurrncy')
  await answer.fill('concurrency')
  await answer.press('Enter')
  await expect(page.locator('.learn-practice-area [role="alert"]')).toContainText('Correct. Keep going.')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByRole('heading', { name: 'deadlock' })).toBeVisible()
  await page.getByRole('button', { name: 'End session' }).click()
  await expect(page.getByRole('heading', { name: 'Continue your session?' })).toBeVisible()
  await page.getByRole('button', { name: 'End and save session' }).click()
  await expect(page.getByText('1 of 10 new words completed today')).toBeVisible()
  await expect(page.getByText('1 new words available', { exact: false })).toBeVisible()

  expect(records(backend.db, 'practice_events')).toHaveLength(1)
  expect(records(backend.db, 'learn_sessions')).toHaveLength(1)
  expect(backend.db.prepare('SELECT count(*) FROM learn_progress').pluck().get()).toBe(1)
})

test('IME composition does not submit and 320px layout has no horizontal overflow', async ({ page, backend }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrency')
  await answer.evaluate((element) => {
    const enter = { key: 'Enter', bubbles: true, cancelable: true }
    element.dispatchEvent(new KeyboardEvent('keydown', { ...enter, isComposing: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', { ...enter, keyCode: 229 }))
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'con' }))
    element.dispatchEvent(new KeyboardEvent('keydown', enter))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'concurrency' }))
  })
  expect(records(backend.db, 'learn_sessions')).toMatchObject([{ currentAttempts: 0 }])
  await expect(page.getByRole('button', { name: 'Check spelling' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
})

test.describe('without a MiniMax key', () => {
  test.use({ speechConfigured: false })
  test('keeps dictation recoverable', async ({ page, backend }) => {
    await makeDeckWithWords(page)
    await page.getByRole('link', { name: 'Start learning' }).click()
    await page.getByText('Dictation', { exact: true }).click()
    await page.getByRole('button', { name: 'Learn 2 new words' }).click()
    await expect(page.getByText('MiniMax speech is not configured on the server.')).toBeVisible()
    await expect(page.locator('.learn-term')).toHaveCount(0)
    expect(records(backend.db, 'practice_events')).toEqual([])
    await page.getByRole('button', { name: 'Switch to Copy' }).click()
    await expect(page.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  })
})

test('keeps dictation hints out of the DOM until submission or reveal and restores an assisted word', async ({ page, backend }) => {
  await trackPlayback(page)
  await page.reload()
  await makeDeckWithWords(page, true)
  const deckId = new URL(page.url()).pathname.split('/').at(-1)!
  const entry = JSON.parse(backend.db.prepare("SELECT body FROM entries WHERE active_term = 'concurrency'").pluck().get() as string)
  const dictionaryMeaning = { senses: [{ partOfSpeech: 'n.', definitions: ['并行推进 concurrency'], source: 'manual' }] }
  expect((await writeStudy(page, 'library/update-entry', [deckId, entry.id, {
    term: entry.term, meaning: entry.meaning, phonetic: entry.phonetic,
    example: 'An example with concurrency', dictionaryMeaning,
  }, entry.revision])).ok()).toBe(true)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()

  const card = page.locator('.learn-card')
  const answer = page.getByRole('textbox', { name: 'Type the dictated word' })
  await expect(answer).toBeFocused()
  await expect.poll(() => backend.speech.requests.map(({ text }) => text)).toEqual(['concurrency'])
  expect(await page.evaluate(() => window.lexynAudio.plays)).toEqual([])
  expect(await card.innerHTML()).not.toContain('concurrency')
  await expect(page.locator('.learn-spelling')).toHaveCount(0)
  await answer.fill('concurrncy')
  expect(await card.innerHTML()).not.toContain('concurrency')
  await expect(page.locator('.learn-spelling')).toHaveCount(0)
  await answer.press('Enter')
  await expect(page.locator('.learn-spelling .letter-missing')).toHaveText('e')
  await expect(page.locator('.learn-spelling')).toHaveAttribute('aria-label', /e: missing/)
  await answer.fill('co')
  await expect(page.locator('.learn-spelling .letter-missing')).toHaveText('e')

  await page.getByRole('button', { name: 'Play English pronunciation' }).click()
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  expect(backend.speech.requests.map(({ text }) => text)).toEqual(['concurrency'])
  await page.getByRole('button', { name: 'Pause pronunciation' }).click()
  expect(await page.evaluate(() => window.lexynAudio.pauses)).toBe(1)
  expect(await card.innerHTML()).not.toContain('concurrency')

  const reveal = page.getByRole('button', { name: 'Reveal answer' })
  await reveal.dblclick()
  await expect(card.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  await expect(card.locator('.dictionary-definition')).toHaveText('并行推进 concurrency')
  await expect(reveal).toHaveCount(0)
  await expect(page.locator('.learn-practice-area [role="alert"]')).toContainText('Answer revealed')
  expect(records(backend.db, 'practice_events')).toEqual([])
  await page.reload()
  await expect(card.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  await expect(answer).toHaveValue('concurrncy')
  await answer.fill('concurrency')
  await page.getByRole('button', { name: 'Check spelling' }).click()
  await expect(page.getByRole('button', { name: 'Next word' })).toBeFocused()
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(answer).toBeFocused()
  await expect(answer).toHaveValue('')
  await expect(page.locator('.learn-spelling')).toHaveCount(0)
  expect(await card.innerHTML()).not.toContain('deadlock')
  await expect(reveal).toBeEnabled()
  expect(records(backend.db, 'practice_events')).toMatchObject([
    { mode: 'dictation', outcome: 'completed', assisted: true, attempts: 2 },
  ])
})

test('Enter submits and advances once, and keyboard shortcuts are scoped to the active word', async ({ page, backend }) => {
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await expect(answer).toBeFocused()
  await answer.fill('concurrency')
  await answer.evaluate((input) => {
    for (const repeat of [false, true, false]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat }))
    }
  })
  const next = page.getByRole('button', { name: 'Next word' })
  await expect(next).toBeFocused()
  expect(records(backend.db, 'learn_sessions')).toMatchObject([{ currentAttempts: 1 }])
  const ignored = await page.locator('.learn-card').evaluate((card) => {
    const field = document.createElement('textarea')
    card.append(field)
    const allowed = field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    field.remove()
    return allowed
  })
  expect(ignored).toBe(true)
  expect(records(backend.db, 'practice_events')).toHaveLength(0)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'deadlock' })).toBeVisible()
  await expect(answer).toBeFocused()
  await expect(answer).toHaveValue('')
  await expect(page.locator('.learn-spelling')).toHaveCount(0)

  await answer.fill('deadlock')
  await page.keyboard.press('Enter')
  await expect(next).toBeFocused()
  await page.getByRole('link', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  expect(records(backend.db, 'learn_sessions')).toMatchObject([{ currentIndex: 1, currentLastSubmitted: 'deadlock' }])
  expect(records(backend.db, 'practice_events')).toMatchObject([{ attempts: 1, outcome: 'completed' }])
})

test('automatically skips removed words and completes the remaining queue without changing prior history', async ({ page, backend }) => {
  await makeDeckWithWords(page)
  const deckUrl = page.url()
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrency')
  await answer.press('Enter')
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByRole('heading', { name: 'deadlock' })).toBeVisible()
  await answer.fill('deadlock')
  await answer.press('Enter')
  await expect(page.getByRole('button', { name: 'Next word' })).toBeFocused()
  const history = records(backend.db, 'practice_events')

  const library = await page.context().newPage()
  await library.goto(deckUrl)
  const word = library.getByRole('article').filter({ has: library.getByRole('heading', { name: 'deadlock' }) })
  await word.getByRole('button', { name: 'Remove word' }).click()
  await library.locator('.library-dialog').getByRole('button', { name: 'Remove word' }).click()
  await expect(word).toHaveCount(0)

  await page.reload()
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  await expect(page.locator('.learn-result-grid')).toContainText('1first learning')
  expect(records(backend.db, 'practice_events')).toEqual(history)
  expect(records(backend.db, 'learn_sessions')).toMatchObject([{ status: 'completed', currentIndex: 0 }])
})

test('retries speech and releases audio on word and route changes', async ({ page, backend }) => {
  await trackPlayback(page)
  await page.reload()
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  backend.speech.failNext = true
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const play = page.getByRole('button', { name: 'Play English pronunciation' })
  await expect(page.getByText('The speech provider is unavailable. Try again.')).toBeVisible()
  expect(records(backend.db, 'practice_events')).toHaveLength(0)
  await play.click()
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  await page.reload()
  await play.click()
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  expect(backend.speech.requests.map(({ text }) => text)).toEqual(['concurrency', 'concurrency'])
  const answer = page.getByRole('textbox', { name: 'Type the dictated word' })
  await answer.fill('concurrency')
  await answer.press('Enter')
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.locator('.learn-meaning')).toContainText('死锁')
  expect(await page.evaluate(() => window.lexynAudio.revoked)).toHaveLength(1)

  await play.click()
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  expect(backend.speech.requests.map(({ text }) => text)).toEqual(['concurrency', 'concurrency', 'deadlock'])
  await page.getByRole('link', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.lexynAudio.revoked)).toHaveLength(2)
  expect(records(backend.db, 'practice_events')).toMatchObject([{ mode: 'dictation', outcome: 'completed', attempts: 1 }])
})

test('pauses when the deck is archived and resumes with the same answer after restore', async ({ page, backend }) => {
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrncy')
  await answer.press('Enter')
  await expect(page.locator('.learn-practice-area [role="alert"]')).toContainText('Not quite')
  const sessionUrl = page.url()

  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'Archive deck' }).click()
  await page.locator('.library-dialog').getByRole('button', { name: 'Archive deck' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await page.goto(sessionUrl)
  await expect(page.getByText('This deck is archived.', { exact: false })).toBeVisible()
  expect(records(backend.db, 'learn_sessions')).toMatchObject([{ status: 'paused', currentAttempts: 1 }])
  await page.getByRole('link', { name: 'Open deck' }).click()
  await page.getByRole('button', { name: 'Restore deck' }).click()
  await expect(page.getByRole('button', { name: 'Add word' })).toBeVisible()
  await page.goto(sessionUrl)
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(answer).toBeFocused()
  await expect(answer).toHaveValue('concurrncy')
  expect(records(backend.db, 'learn_sessions')).toMatchObject([{ status: 'active', currentAttempts: 1 }])
  expect(records(backend.db, 'practice_events')).toEqual([])
})

test('cancels a pending dictation download on switch to Copy and still plays the cached MP3', async ({ page, backend }) => {
  await trackPlayback(page)
  await page.reload()
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const audioPath = '**/api/speech/audio/*'
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  await page.route(audioPath, async (route) => {
    await hold
    await route.continue().catch(() => {})
  })
  const requested = page.waitForRequest(audioPath)
  await page.getByRole('button', { name: 'Play English pronunciation' }).click()
  await requested
  await expect(page.getByRole('button', { name: 'Loading pronunciation…' })).toBeDisabled()
  await page.getByRole('button', { name: 'Switch to Copy' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  release()
  await page.unroute(audioPath)
  await page.getByRole('button', { name: 'Play pronunciation' }).click()
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  expect(await page.evaluate(() => window.lexynAudio.plays)).toHaveLength(1)
  expect(backend.speech.requests.map(({ text }) => text)).toEqual(['concurrency'])
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrency')
  await answer.press('Enter')
  await expect(page.getByRole('button', { name: 'Next word' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'deadlock' })).toBeVisible()
  expect(records(backend.db, 'practice_events')).toMatchObject([{ mode: 'copy', outcome: 'completed' }])
})
