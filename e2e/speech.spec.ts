import type { Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures'
import { trackPlayback } from './mock-speech'

test.use({ speechConfigured: false })

async function saveKey(page: Page) {
  await expect(page.getByText('MiniMax speech is not configured on the server.')).toBeVisible()
  await page.getByLabel('MiniMax API key').fill('mock-key')
  await page.getByRole('button', { name: 'Save pronunciation settings' }).click()
  await expect(page.getByText('MiniMax speech is configured.')).toBeVisible()
  await expect(page.getByLabel('MiniMax API key')).toHaveValue('')
}

test('previews server audio and shares saved voice and speed across devices', async ({ page, backend, browser }) => {
  await trackPlayback(page)
  await page.goto('/settings?section=speech')
  await saveKey(page)
  await page.locator('#speech-voice').click()
  await page.getByText('Patient Man', { exact: true }).click()
  const audio = page.waitForResponse(/\/api\/speech\/audio\/[a-f0-9]{64}$/)
  await page.getByRole('button', { name: 'Preview voice' }).click()
  expect((await audio).headers()['content-type']).toBe('audio/mpeg')
  await expect(page.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
  await page.locator('#speech-rate').click()
  await page.getByText('1.2×', { exact: true }).click()
  await page.getByRole('button', { name: 'Save pronunciation settings' }).click()
  await expect(page.getByText('Pronunciation settings saved.')).toBeVisible()

  const device = await browser.newContext()
  try {
    const second = await device.newPage()
    await trackPlayback(second)
    await second.goto(backend.origin + '/settings?section=speech')
    await signIn(second)
    await expect(second.locator('#speech-voice')).toContainText('Patient Man')
    await expect(second.locator('#speech-rate')).toContainText('1.2×')
    await expect(second.getByLabel('MiniMax API key')).toHaveValue('')
    await second.getByRole('button', { name: 'Preview voice' }).click()
    await expect(second.getByRole('button', { name: 'Pause pronunciation' })).toBeVisible()
    expect(await second.evaluate(() => window.lexynAudio.plays[0].rate)).toBe(1.2)
    expect(backend.speech.requests.map((request) => request.voice_setting.voice_id)).toEqual(['English_PatientMan'])
    await second.getByRole('link', { name: 'Close', exact: true }).click()
    await second.getByRole('link', { name: /Owner account/ }).click()
    await second.getByRole('button', { name: 'Sign out' }).click()
    await expect(second.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    expect(await second.evaluate(() => window.lexynAudio.revoked)).toHaveLength(1)
  } finally { await device.close() }
})

test('decodes a mock MP3 through native browser playback', async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = async function () {
      await play.call(this)
      document.documentElement.dataset.playedMp3 = String(this.duration > 0)
    }
  })
  await page.goto('/settings?section=speech')
  await saveKey(page)
  await page.getByRole('button', { name: 'Preview voice' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-played-mp3', 'true')
})
