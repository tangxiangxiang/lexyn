import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type Database from 'better-sqlite3'
import { expect, fillMeaning, test, writeStudy } from './fixtures'
import type { Entry } from '../shared/domain/library'
import { createEcdict } from '../server/dictionary/ecdict'
import { importEcdictCsv } from '../server/dictionary/import'

async function createDeck(page: Page, name = 'Vocabulary Systems') {
  await page.goto('/library')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).click()
  return new URL(page.url()).pathname.split('/').at(-1)!
}

async function createBlankWords(page: Page, deckId: string, terms: string[]) {
  for (const term of terms) {
    const response = await writeStudy(page, 'library/create-entry', [deckId, { term, meaning: '' }])
    expect(response.ok()).toBe(true)
  }
  await page.goto('/library/' + deckId)
}

function savedEntry(db: Database.Database, term: string) {
  const row = db.prepare('SELECT body FROM entries WHERE active_term = ?').get(term.toLowerCase()) as { body: string } | undefined
  return row ? JSON.parse(row.body) as Entry : undefined
}

async function installEcdict(directory: string, term: string, raw: string) {
  const csv = join(directory, 'meaning-reference.csv')
  writeFileSync(csv, 'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n' +
    `${term},θred,a thin cord,"${raw}",n.,,,,,,,,\n`)
  await importEcdictCsv(directory, csv, 'fixture-sha')
}

test('saves a new word before AI, then iterates from the latest human meaning without losing ECDICT', async ({ page, backend }) => {
  await installEcdict(backend.directory, 'thread', 'n. 原始词典释义；织物纤维')
  const dictionary = createEcdict(backend.directory)
  const deckId = await createDeck(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  backend.vocabulary.beforeReply = () => gate
  try {
    await page.getByRole('button', { name: 'Add word' }).click()
    await page.getByLabel('Term', { exact: true }).fill('thread')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => backend.vocabulary.requests).toEqual([['thread']])
    await expect.poll(() => savedEntry(backend.db, 'thread')?.revision).toBe(1)
    expect(savedEntry(backend.db, 'thread')).toMatchObject({ meaning: '', term: 'thread' })
    expect(backend.vocabulary.inputs[0]?.[0]).not.toHaveProperty('currentMeaning')
    expect(backend.vocabulary.inputs[0]?.[0].dictionaryReference).toMatchObject({
      sourceWord: 'thread', sourceRevision: 'fixture-sha', translation: 'n. 原始词典释义；织物纤维',
    })

    const article = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'thread', exact: true }) })
    await article.getByRole('button', { name: 'Edit word' }).click()
    await fillMeaning(page, '用户手动编辑版本 B', 'n.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => savedEntry(backend.db, 'thread')?.meaning).toBe('n. 用户手动编辑版本 B')
  } finally {
    backend.vocabulary.beforeReply = undefined
    release()
  }

  await expect.poll(() => backend.vocabulary.responses).toHaveLength(1)
  expect(savedEntry(backend.db, 'thread')).toMatchObject({ revision: 2, meaning: 'n. 用户手动编辑版本 B' })

  const article = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'thread', exact: true }) })
  await article.getByRole('button', { name: 'Edit word' }).click()
  const meaning = page.getByLabel('Definition 1', { exact: true })
  await expect(meaning).toHaveValue('用户手动编辑版本 B')
  await page.getByRole('button', { name: 'Optimize with AI', exact: true }).click()
  await expect(meaning).toHaveValue('线程的迭代释义 C')
  expect(backend.vocabulary.inputs[1]?.[0].currentMeaning?.text).toBe('n. 用户手动编辑版本 B')
  expect(backend.vocabulary.inputs[1]?.[0].dictionaryReference).toMatchObject({
    sourceWord: 'thread', translation: 'n. 原始词典释义；织物纤维',
  })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(() => savedEntry(backend.db, 'thread')?.meaning).toBe('n. 线程的迭代释义 C')

  expect(savedEntry(backend.db, 'thread')?.dictionaryReference).toMatchObject({
    sourceWord: 'thread', sourceRevision: 'fixture-sha', translation: 'n. 原始词典释义；织物纤维',
  })
  expect(dictionary.lookup('thread').entries[0]?.translation).toBe('n. 原始词典释义；织物纤维')
  expect(backend.vocabulary.requests).toEqual([['thread'], ['thread']])
  dictionary.close()
})

test('batch completion persists task progress and sends every target through MiniMax', async ({ page, backend }) => {
  const deckId = await createDeck(page)
  await createBlankWords(page, deckId, ['thread', 'queue', 'missing'])
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
  await expect(page.getByText(/Saved 2 · failed 1 · skipped 0/)).toBeVisible()
  expect(backend.vocabulary.requests).toHaveLength(1)
  expect(new Set(backend.vocabulary.requests[0])).toEqual(new Set(['thread', 'queue', 'missing']))
  expect(savedEntry(backend.db, 'thread')).toMatchObject({ meaning: 'n. 线程', meaningSource: 'ai', revision: 2 })
  expect(savedEntry(backend.db, 'queue')).toMatchObject({ meaning: 'n. 队列', meaningSource: 'ai', revision: 2 })
  expect(savedEntry(backend.db, 'missing')).toMatchObject({ meaning: '', revision: 1 })
  expect(backend.db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
  expect(backend.db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
})

test('displays complete AI meanings while keeping raw ECDICT and legacy prose out of daily Library UI', async ({ page, backend }) => {
  const raw = 'n. 原始香蕉译文；旧版词典内容'
  await installEcdict(backend.directory, 'banana', raw)
  const dictionary = createEcdict(backend.directory)
  const deckId = await createDeck(page)
  const response = await writeStudy(page, 'library/create-entry', [deckId, {
    term: 'banana', meaning: '', explanation: '不应显示的旧补充解释', example: 'Old example should remain hidden.',
  }])
  expect(response.ok()).toBe(true)
  const created = await response.json()
  const entryId = created.data.id as string
  await page.reload()
  const article = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'banana', exact: true }) })
  await article.getByRole('button', { name: 'Edit word' }).click()
  await page.getByRole('button', { name: 'Optimize with AI', exact: true }).click()
  await expect(page.getByLabel('Definition 1', { exact: true })).toHaveValue('香蕉')
  await expect(page.getByLabel('Definition 2', { exact: true })).toHaveValue('热带水果')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  const saved = savedEntry(backend.db, 'banana')!
  expect(saved.id).toBe(entryId)
  expect(saved.meaning).toBe('n. 香蕉；热带水果')
  expect(saved.dictionaryReference).toMatchObject({ sourceWord: 'banana', translation: raw })
  await expect(article.locator('.dictionary-definition')).toHaveText(['香蕉', '热带水果'])
  await expect(page.getByText(raw, { exact: false })).toHaveCount(0)
  await expect(page.getByText('不应显示的旧补充解释', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Old example should remain hidden.', { exact: false })).toHaveCount(0)
  expect(backend.vocabulary.inputs[0]?.[0].dictionaryReference).toMatchObject({ translation: raw })
  expect(dictionary.lookup('banana').entries[0]?.translation).toBe(raw)
  expect(backend.vocabulary.requests).toEqual([['banana']])
  dictionary.close()
})
