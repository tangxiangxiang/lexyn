import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, openStudyLists, studyRequest, test, writeStudy } from './fixtures'

async function api(page: Page, path: string, args: unknown[] = [], write = false) {
  const response = await (write ? writeStudy(page, path, args) : studyRequest(page, path, args))
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function deckWithApple(page: Page) {
  const deck = await api(page, 'library/create-deck', [{ name: 'Spelling book', listSize: 1 }], true)
  const word = await api(page, 'library/create-entry', [deck.id, { term: 'apple', meaning: '苹果' }], true)
  return { deck, word }
}

async function option(page: Page, label: string) {
  await page.getByLabel('Session options').click()
  await page.getByRole('button', { name: label, exact: true }).click()
}

test('sets synchronized options, corrects a duplicate letter and resumes a free retry without using the formal slot', async ({ page, backend }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.addInitScript(() => {
    const log: string[] = []
    Object.defineProperty(window, 'lexynLetters', { value: log })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class { constructor(readonly text: string) {} },
    })
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ localService: true, lang: 'en-US' }, { localService: true, lang: 'en-GB' }],
      speak: (utterance: SpeechSynthesisUtterance) => {
        log.push(utterance.text + ':' + utterance.lang)
        if (utterance.text === 'L') throw new Error('Test device voice failure')
      },
      cancel: () => {},
    } })
    localStorage.setItem('lexyn.pronunciationAccent', 'british')
  })
  const { deck, word } = await deckWithApple(page)
  const formal = await api(page, 'learn/start', [deck.id, 'copy', [word.id], true], true)
  const initial = await api(page, 'settings/spelling')
  await api(page, 'settings/save-spelling', [{ ...initial, strict: false, retryLimit: 1, syllables: true }], true)
  await page.goto('/settings?section=preferences')
  await page.getByText('Simplified keyboard', { exact: true }).click()
  await expect.poll(() => api(page, 'settings/spelling')).toMatchObject({ keyboard: 'simplified' })
  await page.getByRole('switch', { name: 'Speak typed letters' }).click()
  await expect.poll(() => api(page, 'settings/spelling')).toMatchObject({ speakLetters: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await page.goto('/library')
  await openStudyLists(page, deck.name)
  await page.locator('.app-menu summary').click()
  await page.getByRole('link', { name: 'Free spelling', exact: true }).last().click()
  await page.getByRole('button', { name: 'Start free spelling' }).click()
  await page.getByRole('link', { name: 'Start spelling' }).click()
  const input = page.getByRole('textbox', { name: 'Copy the word' })
  const keyboard = page.getByRole('group', { name: 'On-screen keyboard' })
  const letter = (key: string) => keyboard.getByRole('button', { name: key, exact: true })
  const check = () => page.getByRole('button', { name: 'Check spelling', exact: true }).click()
  await expect(keyboard.getByRole('button')).toHaveCount(5)
  await expect(page.locator('.spell-syllable-separated')).toHaveText(['ap', 'ple'])
  await letter('a').click()
  await letter('p').click()
  await letter('l').click()
  await letter('e').click()
  await expect(input).toHaveValue('aple')
  await check()
  await expect(page.locator('.letter-missing')).toHaveText('p')
  await letter('Delete letter').click()
  await expect(input).toHaveValue('apl')
  await input.press('ArrowLeft')
  await letter('p').click()
  await input.press('ArrowRight')
  await letter('e').click()
  await expect(input).toHaveValue('apple')
  await check()
  await expect(page.getByText('Retry 1', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('')
  expect(await page.evaluate(() => Reflect.get(window, 'lexynLetters'))).toEqual(
    expect.arrayContaining(['P:en-GB', 'L:en-GB']))
  await option(page, 'Pause')
  await page.reload()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page.getByText('Retry 1', { exact: true })).toBeVisible()
  await input.fill('APPLE')
  await check()
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, 'lexynLetters'))).toContain('A:en-GB')
  expect(backend.speech.requests).toEqual([])
  expect(await api(page, 'learn/session', [formal.sessionId])).toMatchObject({ session: { currentIndex: 0, currentAttempts: 0 } })
  expect(await api(page, 'learn/daily', [deck.id])).toMatchObject({ completedToday: 0 })
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
  await page.goto('/library/' + deck.id + '/words?word=' + word.id)
  await page.getByText('Spelling history', { exact: true }).click()
  await expect(page.locator('.spelling-history-positions')).toContainText('3 · p')
})

test('ranks repeated recent spelling errors without counting one old error or assisted practice', async ({ page, backend }) => {
  const { deck, word } = await deckWithApple(page)
  const pear = await api(page, 'library/create-entry', [deck.id, { term: 'pear', meaning: '梨' }], true)
  const now = Date.UTC(2026, 9, 2, 12)
  backend.advanceTo(now)
  const save = backend.db.prepare('INSERT INTO spelling_attempts (id,entry_id,session_id,round,attempt,body,word_id) VALUES (?,?,?,?,?,?,?)')
  function record(entry: typeof word, time: number, assisted = false, correct = false) {
    const row = { id: randomUUID(), entryId: entry.id, sessionId: randomUUID(), round: 0, attempt: 1,
      spelling: entry.term, time, source: 'free', mode: 'copy', keyboard: 'full', assisted, correct,
      errors: correct ? [] : [{ position: 0, expected: entry.term[0], type: 'incorrect' }] }
    save.run(row.id, entry.id, row.sessionId, 0, 1, JSON.stringify(row), entry.wordId)
  }
  record(word, now - 60_000)
  record(word, now - 120_000)
  record(word, now, false, true)
  record(pear, now - 60_000)
  record(pear, now - 31 * 86_400_000)
  record(pear, now, true)
  await page.goto('/library/' + deck.id + '/words')
  await page.getByLabel('Word list options').click()
  await page.getByRole('button', { name: 'Difficult spellings 1' }).click()
  await expect(page.getByRole('link', { name: 'apple', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'pear', exact: true })).toHaveCount(0)
  expect(await api(page, 'progress/overview')).toMatchObject({
    spelling: { freeAttempts: 6, failures: 5 }, learnedTotal: 0, ratedToday: 0, streak: 0,
  })
  record(word, now, false, true)
  record(word, now, false, true)
  await page.reload()
  await page.getByLabel('Word list options').click()
  await expect(page.getByRole('button', { name: /Difficult spellings/ })).toHaveCount(0)
})

test('dictation exposes only generic keys until an assisted keyboard is requested and retains the choice on reload', async ({ page }) => {
  const { deck, word } = await deckWithApple(page)
  const prefs = await api(page, 'settings/spelling')
  await api(page, 'settings/save-spelling', [{ ...prefs, keyboard: 'simplified', syllables: true }], true)
  const session = await api(page, 'learn/start', [deck.id, 'dictation', [word.id], true], true)
  await page.goto('/learn/spell?session=' + session.sessionId)
  const keyboard = page.getByRole('group', { name: 'On-screen keyboard' })
  await expect(keyboard.getByRole('button', { name: 'z', exact: true })).toBeVisible()
  expect(await api(page, 'learn/session', [session.sessionId])).toMatchObject({ entry: { term: '' }, answerVisible: false })
  await option(page, 'Use simplified keyboard')
  await expect(keyboard.getByRole('button', { name: 'z', exact: true })).toHaveCount(0)
  await expect(page.locator('.spell-stage')).not.toContainText('apple')
  await page.reload()
  await expect(keyboard.getByRole('button', { name: 'z', exact: true })).toHaveCount(0)
  const answer = page.getByRole('textbox', { name: 'Type the dictated word' })
  await answer.fill('apple')
  await answer.press('Enter')
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  expect(await api(page, 'learn/history', [session.sessionId, 0, 100])).toMatchObject({
    firstTryCorrect: 0, events: [{ assisted: true, mode: 'dictation', outcome: 'completed' }],
  })
})

test('strict copy clears a failed draft and retries a lost write only once', async ({ page, backend }) => {
  const { deck, word } = await deckWithApple(page)
  const session = await api(page, 'learn/start', [deck.id, 'copy', [word.id], true], true)
  await page.goto('/learn/spell?session=' + session.sessionId)
  const input = page.getByRole('textbox', { name: 'Copy the word' })
  await expect(input).toBeFocused()
  expect(await input.evaluate((element) => element.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true,
  })))).toBe(false)

  const attemptedKeys: string[] = []
  await page.route('**/api/learn/attempt', async (route) => {
    attemptedKeys.push(route.request().headers()['idempotency-key'])
    if (attemptedKeys.length === 1) {
      expect((await route.fetch()).ok()).toBe(true)
      await route.abort()
    } else await route.continue()
  })
  await input.fill('apx')
  await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible()
  await expect(input).toHaveValue('apx')
  await page.getByRole('button', { name: 'Retry connection' }).click()
  await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Check spelling' }).click()
  await expect(input).toHaveValue('')
  expect(attemptedKeys).toHaveLength(2)
  expect(attemptedKeys[1]).toBe(attemptedKeys[0])
  expect(backend.db.prepare('SELECT count(*) FROM spelling_attempts').pluck().get()).toBe(1)
  await input.fill('apple')
  await expect(page.getByText('Session complete', { exact: true })).toBeVisible()
  expect(backend.db.prepare('SELECT count(*) FROM spelling_attempts').pluck().get()).toBe(2)
})
