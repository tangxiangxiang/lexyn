import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type Database from 'better-sqlite3'
import { openStudyLists, expect, libraryAction, fillMeaning, test, writeStudy } from './fixtures'
import type { Entry } from '../shared/domain/library'
import type { ImportCandidate } from '../shared/domain/library-import'
import { createEcdict } from '../server/dictionary/ecdict'
import { importEcdictCsv } from '../server/dictionary/import'

async function createDeck(page: Page, name = 'Vocabulary Systems') {
  await page.goto('/library')
  await page.getByRole('button', { name: 'Create a wordbook' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await openStudyLists(page, name)
  return new URL(page.url()).pathname.split('/').at(-1)!
}

async function createBlankWords(page: Page, deckId: string, terms: string[]) {
  for (const term of terms) {
    const response = await writeStudy(page, 'library/create-entry', [deckId, { term, meaning: '' }])
    expect(response.ok()).toBe(true)
  }
  await page.goto('/library/' + deckId)
}

async function vocabularyRequest(page: Page, path: string, data: object) {
  const sessionResponse = await page.request.get('/api/auth/session', { headers: { 'X-Lexyn-Client': '1' } })
  const { session } = await sessionResponse.json()
  return page.request.post('/api/' + path, {
    headers: { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId,
      Origin: new URL(page.url()).origin, 'Content-Type': 'application/json' }, data,
  })
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

test('generates a meaning and both IPA accents in one request for a new word', async ({ page, backend }) => {
  const deckId = await createDeck(page)
  await libraryAction(page, 'Add word', 'Deck options')
  await page.getByLabel('Term', { exact: true }).fill('command')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => savedEntry(backend.db, 'command')?.revision).toBe(2)
  expect(backend.vocabulary.requests).toEqual([['command']])
  expect(savedEntry(backend.db, 'command')).toMatchObject({
    meaningSource: 'ai', phonetics: { british: 'kəˈmɑːnd', american: 'kəˈmænd' },
  })
  await expect(page.locator('.phonetics span')).toHaveText(['UK /kəˈmɑːnd/', 'US /kəˈmænd/'])
  const seeded = await writeStudy(page, 'library/create-entry', [deckId, {
    term: 'queue', meaning: '队列', phonetics: { american: '/kjuː/' },
  }])
  expect(seeded.ok()).toBe(true)
  await page.reload()
  const queue = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'queue', exact: true }) })
  await expect(queue.locator('.phonetics span')).toHaveText(['US /kjuː/'])
})

test('shows generic ECDICT IPA without a label and honors a clear from the editor', async ({ page, backend }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await installEcdict(backend.directory, 'thread', 'n. 线；织物纤维')
  await createDeck(page)
  await libraryAction(page, 'Add word', 'Deck options')
  await page.getByLabel('Term', { exact: true }).fill('thread')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const article = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'thread', exact: true }) })
  await expect(article.locator('.phonetics span')).toHaveText(['/θred/'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await libraryAction(article, 'Edit word')
  const phonetic = page.getByLabel('Generic IPA', { exact: true })
  await expect(phonetic).toHaveValue('θred')
  await phonetic.clear()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => savedEntry(backend.db, 'thread')?.phoneticsCleared).toBe(true)
  await libraryAction(article, 'Edit word')
  await page.getByRole('button', { name: 'Optimize with AI', exact: true }).click()
  await expect.poll(() => savedEntry(backend.db, 'thread')?.revision).toBe(4)
  await expect(phonetic).toHaveValue('')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(article.locator('.phonetics')).toHaveCount(0)
})

test('saves a new word before AI, then iterates from the latest human meaning without losing ECDICT', async ({ page, backend }) => {
  await installEcdict(backend.directory, 'thread', 'n. 原始词典释义；织物纤维')
  const dictionary = createEcdict(backend.directory)
  const deckId = await createDeck(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  backend.vocabulary.beforeReply = () => gate
  try {
    await libraryAction(page, 'Add word', 'Deck options')
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
    await libraryAction(article, 'Edit word')
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
  await libraryAction(article, 'Edit word')
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

test('CSV meaning becomes the next AI iteration while the same-word ECDICT reference stays immutable', async ({ page, backend }) => {
  await installEcdict(backend.directory, 'thread', 'n. 原始词典释义；织物纤维')
  const deckId = await createDeck(page)
  const created = await writeStudy(page, 'library/create-entry', [deckId, { term: 'thread', meaning: '' }])
  expect(created.ok()).toBe(true)
  const entry = (await created.json()).data as Entry

  expect((await vocabularyRequest(page, `vocabulary/auto/${entry.id}`, { revision: entry.revision })).status()).toBe(202)
  await expect.poll(() => savedEntry(backend.db, 'thread')?.revision).toBe(2)
  const versionA = savedEntry(backend.db, 'thread')!
  const referenceA = versionA.dictionaryReference

  const previewResponse = await writeStudy(page, 'library/import-preview', [deckId,
    'term,meaning\nthread,CSV 导入版本 B', 'csv', 'auto', { term: 0, meaning: 1 }])
  expect(previewResponse.ok()).toBe(true)
  const preview = (await previewResponse.json()).data as { candidates: ImportCandidate[] }
  const imported = await writeStudy(page, 'library/import', [deckId, preview.candidates, 'overwrite'])
  expect(imported.ok()).toBe(true)
  const versionB = savedEntry(backend.db, 'thread')!
  expect(versionB).toMatchObject({
    revision: versionA.revision + 1,
    meaning: 'CSV 导入版本 B', meaningSource: 'manual',
    dictionaryMeaning: { senses: [{ partOfSpeech: '', definitions: ['CSV 导入版本 B'], source: 'manual' }] },
    dictionaryReference: referenceA,
  })

  expect((await vocabularyRequest(page, `vocabulary/optimize/${entry.id}`, { revision: versionB.revision })).status()).toBe(200)
  const prompt = backend.vocabulary.inputs.at(-1)?.[0]
  expect(prompt?.currentMeaning?.text).toBe('CSV 导入版本 B')
  expect(prompt?.dictionaryReference).toMatchObject({ translation: referenceA?.translation })
  expect(savedEntry(backend.db, 'thread')).toMatchObject({
    revision: versionB.revision + 1,
    meaning: 'n. 线程的迭代释义 C',
    dictionaryReference: referenceA,
  })
})

test('batch completion persists task progress and sends every target through MiniMax', async ({ page, backend }) => {
  const deckId = await createDeck(page)
  await createBlankWords(page, deckId, ['thread', 'queue', 'missing'])
  await page.getByRole('button', { name: 'Search and filters' }).click()
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
    await page.getByRole('button', { name: 'Search and filters' }).click()
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
  await libraryAction(article, 'Edit word')
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
