import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import type { LearnSession, PracticeEvent } from '../shared/domain/learning'
import type Database from 'better-sqlite3'

interface SpeechMock {
  spoken: string[]
  cancels: number
  listeners: number
  failNext: boolean
  setEnglish: (available: boolean) => void
}

declare global {
  interface Window { lexynSpeechMock: SpeechMock }
}

async function mockSpeech(page: Page, initiallyReady: boolean) {
  await page.addInitScript((ready) => {
    const voice = { name: 'Mock English', lang: 'en-US', default: true, localService: true, voiceURI: 'mock-en' }
    const events = new EventTarget()
    let english = ready
    class Utterance {
      onstart?: () => void
      onerror?: () => void
      constructor(public text: string) {}
    }
    let active: Utterance | undefined
    const mock: SpeechMock = {
      spoken: [], cancels: 0, listeners: 0, failNext: false,
      setEnglish(available) {
        english = available
        events.dispatchEvent(new Event('voiceschanged'))
      },
    }
    window.lexynSpeechMock = mock
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => english ? [voice] : [],
      addEventListener(type: string, listener: EventListener) {
        mock.listeners++
        events.addEventListener(type, listener)
      },
      removeEventListener(type: string, listener: EventListener) {
        mock.listeners--
        events.removeEventListener(type, listener)
      },
      cancel() {
        mock.cancels++
        active?.onerror?.()
        active = undefined
      },
      speak(utterance: Utterance) {
        mock.spoken.push(utterance.text)
        if (mock.failNext) {
          mock.failNext = false
          utterance.onerror?.()
          return
        }
        active = utterance
        utterance.onstart?.()
      },
    } })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance })
  }, initiallyReady)
}

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
    await page.getByLabel('Meaning optional', { exact: true }).fill(spellingHints ? term + ' ' + meaning : meaning)
    if (spellingHints) {
      await page.getByLabel('Phonetic optional', { exact: true }).fill(term)
      await page.getByLabel('Example optional', { exact: true }).fill('An example with ' + term)
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

test('disables dictation cleanly when the browser has no speech synthesis and allows Copy', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined })
  })
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  await expect(page.getByText('Dictation needs an English voice on this device.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Learn 2 new words' })).toBeDisabled()
  await page.getByText('Copy', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Learn 2 new words' })).toBeEnabled()
})

test('keeps dictation hints out of the DOM until submission or reveal and restores an assisted word', async ({ page, backend }) => {
  await mockSpeech(page, true)
  await makeDeckWithWords(page, true)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()

  const card = page.locator('.learn-card')
  const answer = page.getByRole('textbox', { name: 'Type the dictated word' })
  await expect(answer).toBeFocused()
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
  await expect.poll(() => page.evaluate(() => window.lexynSpeechMock.spoken)).toEqual(['concurrency'])
  await page.getByRole('button', { name: 'Playing…' }).click()
  expect(await page.evaluate(() => window.lexynSpeechMock.cancels)).toBe(1)

  const reveal = page.getByRole('button', { name: 'Reveal answer' })
  await reveal.dblclick()
  await expect(card.getByRole('heading', { name: 'concurrency' })).toBeVisible()
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

test('recovers dictation after a voice timeout, survives playback errors and stops speech on word and route changes', async ({ page, backend }) => {
  await mockSpeech(page, false)
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  const start = page.getByRole('button', { name: 'Learn 2 new words' })
  await expect(page.getByText('Waiting for an English voice…', { exact: false })).toBeVisible()
  await expect(start).toBeDisabled()
  await expect(page.getByText('No English voice is available on this device.', { exact: false })).toBeVisible()
  await page.evaluate(() => window.lexynSpeechMock.setEnglish(true))
  await expect(start).toBeEnabled()
  await start.click()

  const play = page.getByRole('button', { name: 'Play English pronunciation' })
  await page.evaluate(() => { window.lexynSpeechMock.failNext = true })
  await play.click()
  await expect(page.getByText('Speech could not be played.', { exact: false })).toBeVisible()
  expect(records(backend.db, 'practice_events')).toHaveLength(0)
  await play.click()
  await expect(page.getByRole('button', { name: 'Playing…' })).toBeVisible()
  const answer = page.getByRole('textbox', { name: 'Type the dictated word' })
  await answer.fill('concurrency')
  await answer.press('Enter')
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByText('死锁', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.lexynSpeechMock.cancels)).toBe(1)

  await page.evaluate(() => window.lexynSpeechMock.setEnglish(false))
  await expect(play).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Switch to Copy' })).toBeEnabled()
  await page.evaluate(() => window.lexynSpeechMock.setEnglish(true))
  await play.click()
  await expect.poll(() => page.evaluate(() => window.lexynSpeechMock.spoken)).toEqual(['concurrency', 'concurrency', 'deadlock'])
  await page.getByRole('link', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({
    cancels: window.lexynSpeechMock.cancels, listeners: window.lexynSpeechMock.listeners,
  }))).toEqual({ cancels: 2, listeners: 0 })
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

test('enables dictation on voiceschanged while loading and switches to Copy if English disappears', async ({ page, backend }) => {
  await mockSpeech(page, false)
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  await expect(page.getByText('Waiting for an English voice…', { exact: false })).toBeVisible()
  await page.evaluate(() => window.lexynSpeechMock.setEnglish(true))
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  await page.getByRole('button', { name: 'Play English pronunciation' }).click()
  await page.evaluate(() => window.lexynSpeechMock.setEnglish(false))
  await page.getByRole('button', { name: 'Switch to Copy' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  expect(await page.evaluate(() => window.lexynSpeechMock.cancels)).toBe(1)
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrency')
  await answer.press('Enter')
  await expect(page.getByRole('button', { name: 'Next word' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'deadlock' })).toBeVisible()
  expect(records(backend.db, 'practice_events')).toMatchObject([{ mode: 'copy', outcome: 'completed' }])
})
