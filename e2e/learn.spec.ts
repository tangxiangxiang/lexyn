import { expect, test, type Page } from '@playwright/test'

async function makeDeckWithWords(page: Page) {
  await page.goto('/library')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill('Learn Systems')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name: 'Learn Systems' }).click()
  for (const [term, meaning] of [['concurrency', '并发'], ['deadlock', '死锁']]) {
    await page.getByRole('button', { name: 'Add word' }).click()
    await page.getByLabel('Term', { exact: true }).fill(term)
    await page.getByLabel('Meaning optional', { exact: true }).fill(meaning)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: term })).toBeVisible()
  }
}

test('learns a new word, retries a misspelling, resumes after reload and persists local practice history', async ({ page }) => {
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.context().setOffline(true)
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
  await page.context().setOffline(false)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'concurrency' })).toBeVisible()
  await page.getByRole('button', { name: 'Next word' }).click()
  await expect(page.getByRole('heading', { name: 'deadlock' })).toBeVisible()
  await page.getByRole('button', { name: 'End session' }).click()
  await expect(page.getByRole('heading', { name: 'Continue your session?' })).toBeVisible()
  await page.getByRole('button', { name: 'End and save session' }).click()
  await expect(page.getByText('1 of 10 new words completed today')).toBeVisible()
  await expect(page.getByText('1 new words available', { exact: false })).toBeVisible()

  const stored = await page.evaluate(async () => {
    const opening = indexedDB.open('lexyn')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    const result = await new Promise<{ events: number; progress: number; sessions: number }>((resolve, reject) => {
      const transaction = database.transaction(['practice_events', 'learn_progress', 'learn_sessions'], 'readonly')
      const counts = { events: 0, progress: 0, sessions: 0 }
      for (const [table, key] of [['practice_events', 'events'], ['learn_progress', 'progress'], ['learn_sessions', 'sessions']] as const) {
        const request = transaction.objectStore(table).count()
        request.onsuccess = () => { counts[key] = request.result }
      }
      transaction.oncomplete = () => resolve(counts)
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
    return result
  })
  expect(stored).toMatchObject({ events: 1, progress: 1, sessions: 1 })
})

test('IME composition does not submit and 320px layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  const answer = page.getByRole('textbox', { name: 'Copy the word' })
  await answer.fill('concurrency')
  await answer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'con' }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'concurrency' }))
  })
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

test('uses the mocked English voice, keeps the answer hidden, and records reveal as assisted', async ({ page }) => {
  await page.addInitScript(() => {
    const voice = { name: 'Mock English', lang: 'en-US', default: true, localService: true, voiceURI: 'mock-en' }
    const calls: { spoken: string[]; cancels: number } = { spoken: [], cancels: 0 }
    Object.defineProperty(window, '__speechMockCalls', { configurable: true, value: calls })
    const synth = {
      getVoices: () => [voice],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel: () => { calls.cancels++ },
      speak: (utterance: { text: string; onstart?: () => void }) => {
        calls.spoken.push(utterance.text)
        utterance.onstart?.()
      },
    }
    class MockUtterance {
      text: string
      lang = ''
      voice?: typeof voice
      onstart?: () => void
      onend?: () => void
      onerror?: () => void
      constructor(text: string) { this.text = text }
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: MockUtterance })
  })
  await makeDeckWithWords(page)
  await page.getByRole('link', { name: 'Start learning' }).click()
  await page.getByText('Dictation', { exact: true }).click()
  await page.getByRole('button', { name: 'Learn 2 new words' }).click()
  await expect(page.getByRole('heading', { name: 'concurrency' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Play English pronunciation' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__speechMockCalls.spoken)).toEqual(['concurrency'])
  await page.getByRole('button', { name: 'Playing…' }).click()
  expect(await page.evaluate(() => (window as any).__speechMockCalls.cancels)).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: 'Reveal answer' }).click()
  await expect(page.locator('.learn-practice-area [role="alert"]')).toContainText('Answer revealed')
  const answer = page.getByRole('textbox', { name: 'Type the dictated word' })
  await answer.fill('concurrency')
  await page.getByRole('button', { name: 'Check spelling' }).click()
  await expect(page.locator('.learn-practice-area [role="alert"]')).toContainText('Correct on your first try')
  await page.getByRole('button', { name: 'Next word' }).click()
  const event = await page.evaluate(async () => {
    const opening = indexedDB.open('lexyn')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    const records = await new Promise<any[]>((resolve, reject) => {
      const request = database.transaction('practice_events').objectStore('practice_events').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return records[0]
  })
  expect(event).toMatchObject({ mode: 'dictation', outcome: 'completed', assisted: true })
})
