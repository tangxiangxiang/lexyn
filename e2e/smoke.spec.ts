import { expect, test } from './fixtures'

test('starts at Library and supports every route and deep-link reload', async ({ page }) => {
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.goto('/')
  await expect(page).toHaveURL(/\/library$/)
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await expect(page.locator('.service-status')).toHaveCount(0)

  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  for (const title of ['Learn', 'Review', 'Progress', 'Settings', 'Library']) {
    const link = navigation.getByRole('link', { name: title })
    await link.click()
    await expect(page).toHaveURL(new RegExp(`/${title.toLowerCase()}$`))
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(link).toHaveAttribute('aria-current', 'page')
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
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
    await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
