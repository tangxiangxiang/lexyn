import { navigateFromMenu, expect, test, wordbookLink } from './fixtures'

test('navigates from the current book and supports direct routes and reloads', async ({ page }) => {
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.goto('/')
  await expect(page).toHaveURL(/\/study$/)
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await expect(page.locator('.service-status')).toHaveCount(0)

  await page.getByRole('button', { name: 'Create a wordbook' }).click()
  await page.getByLabel('Deck name').fill('Navigation fixture')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await wordbookLink(page, 'Navigation fixture').click()
  await page.getByRole('link', { name: 'Lexyn home' }).click()
  await expect(page.getByRole('heading', { name: 'Current book' })).toBeVisible()

  await navigateFromMenu(page, 'Settings')
  await expect(page).toHaveURL(/\/settings(?:\?|$)/)
  await page.reload()
  await expect(page.getByRole('link', { name: /^My books/ })).toBeVisible()
  await page.getByRole('link', { name: 'Close' }).click()
  await expect(page).toHaveURL(/\/study$/)
  await navigateFromMenu(page, 'Study activity')
  await expect(page).toHaveURL(/\/activity$/)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Study activity' })).toBeVisible()
  await page.goto('/study')
  await navigateFromMenu(page, 'Open word list')
  await expect(page.getByRole('heading', { name: 'My words (0)' })).toBeVisible()

  await page.goto('/learn')
  const menu = page.getByRole('navigation', { name: 'Main navigation' })
  const reviewLink = menu.getByRole('link', { name: 'Review', exact: true })
  await expect(reviewLink).toBeHidden()
  for (const title of ['Review', 'Progress', 'Learn', 'Library']) {
    await navigateFromMenu(page, title)
    await expect(page).toHaveURL(new RegExp(`/${title.toLowerCase()}$`))
    const heading = page.getByRole('heading', { level: 1, name: title === 'Library' ? /^My books/ : title })
    await expect(heading).toBeVisible()
    await page.reload()
    await expect(heading).toBeVisible()
    if (title !== 'Library') {
      await menu.locator('summary').click()
      await expect(menu.getByRole('link', { name: title, exact: true })).toHaveAttribute('aria-current', 'page')
      await menu.locator('summary').press('Escape')
      await expect(menu.getByRole('link', { name: title, exact: true })).toBeHidden()
    }
  }
  expect(errors).toEqual([])
})

test('serves API and static assets from the production origin', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ status: 'ok', database: 'ok' })

  const icon = await request.get('/favicon.svg')
  expect(icon.ok()).toBe(true)
  expect(icon.headers()['content-type']).toContain('image/svg+xml')

  const missing = await request.get('/api/unknown')
  expect(missing.status()).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  expect((await request.get('/api')).status()).toBe(404)
  expect((await request.get('/assets/missing.js')).status()).toBe(404)
})

test('persists the selected appearance in the browser after a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/settings')
  await page.getByRole('link', { name: 'Study preferences', exact: true }).click()
  const shell = page.locator('.app-shell')
  await expect(shell).toHaveAttribute('data-theme', 'light')
  await page.getByText('Dark', { exact: true }).click()
  await expect(shell).toHaveAttribute('data-theme', 'dark')

  await page.reload()
  await expect(shell).toHaveAttribute('data-theme', 'dark')
  await page.getByText('Light', { exact: true }).click()
  await expect(shell).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked()
})

test('shows a recoverable page error and keeps navigation available when the API fails', async ({ page }) => {
  const decks = /\/api\/library\/decks\?/
  await page.route(decks, (route) => route.abort())
  await page.reload()
  await expect(page.getByText('Cannot connect to Lexyn.', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to study' })).toBeVisible()
  await page.unroute(decks)
  await page.getByRole('button', { name: 'Retry connection' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await expect(page.locator('.service-status')).toHaveCount(0)
})

for (const [name, width, height] of [
  ['phone', 320, 740],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
] as const) {
  test(`${name} layout fits the viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/library')
    await expect(page.getByRole('heading', { level: 1, name: /^My books/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.goto('/settings')
    await expect(page.getByRole('link', { name: /^My books/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.getByRole('link', { name: /^Learning plan/ }).click()
    await expect(page.getByRole('group', { name: 'Weekly plan' })).toBeVisible()
    await page.getByRole('button', { name: /^Review reset time/ }).click()
    await expect(page.getByLabel('Review reset time', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
