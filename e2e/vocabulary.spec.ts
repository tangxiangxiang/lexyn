import type { Page } from '@playwright/test'
import type { Entry } from '../shared/domain/library'
import { expect, test, writeStudy } from './fixtures'

async function deckWithWords(page: Page, terms: string[] = []) {
  const { data: deck } = await (await writeStudy(page, 'library/create-deck', [{ name: 'Core Java' }])).json()
  for (const term of terms) {
    const response = await writeStudy(page, 'library/create-entry', [deck.id, { term, meaning: '' }])
    expect(response.ok()).toBe(true)
  }
  await page.goto('/library/' + deck.id)
  await expect(page.getByRole('heading', { name: 'Core Java' })).toBeVisible()
}

test('fills the form directly and ignores stale terms and fields edited during generation', async ({ page, backend }) => {
  await deckWithWords(page)
  await page.getByRole('button', { name: 'Add word' }).click()
  const term = page.getByLabel('Term', { exact: true })
  const generate = page.getByRole('button', { name: 'Fill with AI' })
  const meaning = page.getByLabel('Meaning optional')
  const explanation = page.getByLabel('Explanation optional')
  await term.fill('thread')

  async function whileGenerating(terms: string[][], action: () => Promise<void>) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    backend.vocabulary.beforeReply = () => gate
    try {
      await generate.click()
      await expect.poll(() => backend.vocabulary.requests).toEqual(terms)
      await action()
    } finally {
      backend.vocabulary.beforeReply = undefined
      release()
    }
  }
  await whileGenerating([['thread']], () => term.fill('queue'))
  await expect(generate).toBeEnabled()
  await expect(meaning).toHaveValue('')
  await whileGenerating([['thread'], ['queue']], () => explanation.fill('我自己写的解释。'))
  await expect(meaning).toHaveValue('队列')
  await expect(explanation).toHaveValue('我自己写的解释。')
  expect(backend.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(0)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Words' }).getByText('队列', { exact: true })).toBeVisible()
  const saved = JSON.parse(backend.db.prepare('SELECT body FROM entries').pluck().get() as string) as Entry
  expect(saved).toMatchObject({ term: 'queue', meaning: '队列', meaningSource: 'ai', explanation: '我自己写的解释。' })

  await page.getByRole('button', { name: 'Edit word' }).click()
  await meaning.fill('等待处理的队列')
  await page.getByRole('button', { name: 'Regenerate with AI' }).click()
  await expect(meaning).toHaveValue('队列')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(JSON.parse(backend.db.prepare('SELECT body FROM entries').pluck().get() as string)).toEqual(saved)
})

test('starts with one confirmation, resumes progress after refresh and automatically saves valid meanings', async ({ page, backend }) => {
  await deckWithWords(page, ['thread', 'queue', 'missing'])
  await page.getByRole('button', { name: 'Needs meaning', exact: true }).click()
  await page.getByRole('button', { name: 'AI fill missing meanings' }).click()
  await expect(page.getByText(/This task will process up to 3/)).toBeVisible()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  backend.vocabulary.beforeReply = () => gate
  try {
    await page.getByRole('button', { name: 'Start AI task for 3 words' }).click()
    await expect(page.getByText('AI vocabulary task running')).toBeVisible()
    await expect.poll(() => backend.vocabulary.requests).toHaveLength(1)
    await page.reload()
    await page.getByRole('button', { name: 'View AI task progress' }).click()
    await expect(page.getByText('AI vocabulary task running')).toBeVisible()
    await expect(page.getByText('Total 3 · processed 0')).toBeVisible()
  } finally {
    backend.vocabulary.beforeReply = undefined
    release()
  }
  await expect(page.getByText('AI vocabulary task completed')).toBeVisible()
  await expect(page.getByText('Saved 2 · failed 1 · skipped 0 · suggested checks 1')).toBeVisible()
  expect(backend.vocabulary.requests).toHaveLength(1)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Suggested check', exact: true }).click()
  const list = page.getByRole('list', { name: 'Words' })
  await expect(list.getByRole('heading', { name: 'thread', exact: true })).toBeVisible()
  await expect(list.getByRole('heading', { name: 'queue', exact: true })).toHaveCount(0)
  await expect(list.getByText('Suggested check', { exact: true })).toBeVisible()
  await list.getByRole('button', { name: 'Edit word' }).click()
  await page.getByLabel('Meaning optional').fill('工作线程')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('No words suggested for checking')).toBeVisible()
  const rows = backend.db.prepare('SELECT body FROM entries').pluck().all().map((body) => JSON.parse(body as string) as Entry)
  expect(rows.find(({ term }) => term === 'thread')).toMatchObject({ meaning: '工作线程', revision: 3, meaningSource: 'manual' })
  expect(rows.find(({ term }) => term === 'thread')?.meaningNeedsReview).toBeUndefined()
  expect(rows.find(({ term }) => term === 'queue')).toMatchObject({ meaning: '队列', revision: 2, meaningSource: 'ai' })
  expect(rows.find(({ term }) => term === 'missing')).toMatchObject({ meaning: '', revision: 1 })
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
})
