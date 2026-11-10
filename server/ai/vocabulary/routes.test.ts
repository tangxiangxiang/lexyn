import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Entry } from '../../../shared/domain/library.ts'
import type { VocabularyPlan } from '../../../shared/contracts/vocabulary.ts'
import { createApp } from '../../app.ts'
import { initializeOwner } from '../../auth/owner.ts'
import { openDatabase } from '../../db/database.ts'
import { createSpeechCredentials } from '../../speech/credentials.ts'
import { importEcdictCsv } from '../../dictionary/import.ts'
import { createStudyStore } from '../../study/store.ts'

const origin = 'http://127.0.0.1:3000'
const password = 'test-owner-password'
const key = 'fake-credential-for-tests'
const send = vi.fn<typeof fetch>(async (_url, init) => {
  const { messages } = JSON.parse(String(init?.body))
  const { words } = JSON.parse(messages[1].content) as { words: { ref: number; term: string }[] }
  const results = words.filter(({ term }) => term !== 'missing').reverse().map((word) => ({
    ...word, meaning: '线程', explanation: '进程中的执行单元。', example: 'Start a worker thread.', needsReview: word.term === 'thread', warning: null,
  }))
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] })
})
let directory: string
let db: ReturnType<typeof openDatabase>
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
const create = () => createApp(db, undefined, origin, Date.now, undefined, { dataDir: directory }, send)

beforeEach(async () => {
  send.mockClear()
  directory = mkdtempSync(join(tmpdir(), 'lexyn-vocabulary-test-'))
  db = openDatabase(directory)
  await initializeOwner(db, 'test-admin', password)
  app = create()
  const login = await app.request('/api/auth/login', { method: 'POST',
    headers: { 'X-Lexyn-Client': '1', 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'test-admin', password }) })
  const { session } = await login.json()
  headers = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId, Cookie: login.headers.get('Set-Cookie')!.split(';')[0],
    Origin: origin, 'Content-Type': 'application/json' }
  createSpeechCredentials(db, directory).save(session.ownerId, key)
})
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

function api(path: string, data?: object, extra?: Record<string, string>) {
  return app.request('/api/' + path, { method: data ? 'POST' : 'GET', headers: { ...headers, ...extra },
    body: data && JSON.stringify(data) })
}
async function library<T>(path: string, args: unknown[]) {
  const response = await api('library/' + path, args, { 'Idempotency-Key': randomUUID() })
  expect(response.status).toBe(200)
  return (await response.json()).data as T
}
const deck = () => library<{ id: string }>('create-deck', [{ name: 'Java', description: 'Core Java concepts' }])
const word = (deckId: string, term: string, meaning = '') =>
  library<Entry>('create-entry', [deckId, { term, meaning, note: 'mine', pronunciationOverride: 'manual reading' }])
const snapshot = (id: string): Entry => JSON.parse(db.prepare('SELECT body FROM entries WHERE id=?').pluck().get(id) as string)
const plan = async (path: string): Promise<VocabularyPlan> => (await api(path)).json()
const readJob = async (path: string) => (await plan(path)).job!
const start = (path: string, count: number, afterTaskId: string | null = null, requestId = randomUUID()) =>
  api(path, { requestId, afterTaskId, count })
const seed = (deckId: string, count: number) => {
  const store = createStudyStore(db, headers['X-Lexyn-Owner'])
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const term = 'term-' + String(index).padStart(4, '0')
      store.saveEntry({ id: randomUUID(), deckId, term, normalizedTerm: term, meaning: '', revision: 1, createdAt: 1, updatedAt: 1 })
    }
  })()
}
const select = ({ id, revision }: Entry) => ({ entryId: id, revision })

test('requires Owner and origin, generates candidates without changing existing words or FSRS', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', '旧释义')
  expect((await api('vocabulary/status', undefined, { Cookie: '' })).status).toBe(401)
  expect((await api('vocabulary/candidate', { deckId, term: 'thread' }, { Origin: 'https://elsewhere.invalid' })).status).toBe(403)
  expect((await api('vocabulary/candidate', { deckId, term: 'thread', ...select(entry), revision: 2 })).status).toBe(409)
  expect((await api('vocabulary/candidate', { deckId, term: 'thread', ...select(entry) })).status).toBe(200)
  expect((await api('vocabulary/candidate', { deckId, term: 'interface' })).status).toBe(200)
  expect(snapshot(entry.id)).toEqual(entry)
  expect(send).toHaveBeenCalledTimes(2)
  expect(db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
  expect(db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
  expect(await (await api('vocabulary/status')).json()).toMatchObject({ status: 'available' })
})

test('automatically saves validated partial results across pages and keeps explanation, example and manual edits', async () => {
  const { id: deckId } = await deck()
  seed(deckId, 50)
  const first = await library<Entry>('create-entry', [deckId, {
    term: 'thread', meaning: '', explanation: '自己写的解释。', example: 'My example.', phonetic: 'manual phonetic',
    note: 'mine', pronunciationOverride: 'manual reading',
  }])
  const filled = await word(deckId, 'filled', '原有释义')
  const removed = await word(deckId, 'removed')
  const missing = await word(deckId, 'missing')
  await library('remove-entry', [deckId, removed.id, true, removed.revision])
  const path = 'vocabulary/batch/' + deckId
  expect(await plan(path)).toMatchObject({ missing: 52, limit: 1000 })
  const requestId = randomUUID()
  expect((await start(path, 52, null, requestId)).status).toBe(202)
  expect((await (await start(path, 52, null, requestId)).json()).id).toBe(requestId)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect(await readJob(path)).toMatchObject({ processed: 52, succeeded: 51, failed: 1, skipped: 0, needsReview: 1 })
  expect(send).toHaveBeenCalledTimes(11)
  expect(snapshot(missing.id)).toEqual(missing)
  expect(snapshot(filled.id)).toEqual(filled)
  expect(snapshot(removed.id)).toMatchObject({ meaning: '', revision: 2 })
  expect(snapshot(first.id)).toMatchObject({
    meaning: '线程', meaningSource: 'ai', meaningNeedsReview: true, explanation: '自己写的解释。', example: 'My example.',
    phonetic: first.phonetic, note: first.note, pronunciationOverride: first.pronunciationOverride, revision: 2,
  })
  const filtered = await (await api('library/deck?args=' + encodeURIComponent(JSON.stringify([deckId, '', 'review', 0, 50])))).json()
  expect(filtered.data.entries.map(({ id }: Entry) => id)).toEqual([first.id])
  const exported = await api('backup/library?args=%5Bnull%5D')
  expect(exported.status).toBe(200)
  const backup = await exported.json()
  expect(backup.data.entries).toContainEqual(expect.objectContaining({ id: first.id, meaningSource: 'ai', meaningNeedsReview: true }))
  expect(JSON.stringify(backup)).not.toContain(key)

  await library('update-entry', [deckId, first.id, { ...editable(first), meaning: '线程', explanation: '新解释。' }, 2])
  expect(snapshot(first.id)).toMatchObject({ meaningSource: 'ai', meaningNeedsReview: true })
  await library('update-entry', [deckId, first.id, { ...editable(first), meaning: '人工改写的释义' }, 3])
  expect(snapshot(first.id)).toMatchObject({ meaningSource: 'manual', revision: 4 })
  expect(snapshot(first.id).meaningNeedsReview).toBeUndefined()
})

function editable(entry: Entry) {
  const { term, meaning, explanation, example, phonetic, pronunciationOverride, note } = entry
  return { term, meaning, explanation, example, phonetic, pronunciationOverride, note }
}

function holdNextRequest() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = send.getMockImplementation()!
  send.mockImplementationOnce(async (...args) => { await gate; return original(...args) })
  return release
}

test('skips revision conflicts while saving other words in the same group', async () => {
  const { id: deckId } = await deck()
  const first = await word(deckId, 'thread')
  const second = await word(deckId, 'queue')
  const path = 'vocabulary/batch/' + deckId
  const release = holdNextRequest()
  try {
    expect((await start(path, 2)).status).toBe(202)
    expect((await readJob(path)).status).toBe('running')
    await library('update-entry', [deckId, second.id, { term: second.term, meaning: '人工释义' }, second.revision])
  } finally { release() }
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect(await readJob(path)).toMatchObject({ succeeded: 1, skipped: 1, conflicts: 1 })
  expect(snapshot(first.id)).toMatchObject({ meaningSource: 'ai', revision: 2 })
  expect(snapshot(second.id)).toMatchObject({ meaning: '人工释义', meaningSource: 'manual', revision: 2 })
  for (const table of ['practice_events', 'review_events', 'review_cards', 'learn_progress', 'learn_sessions', 'review_sessions']) {
    expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0)
  }
})

test('enforces the 1000-word cap and stops further requests while keeping committed results', async () => {
  const { id: deckId } = await deck()
  seed(deckId, 1001)
  const path = 'vocabulary/batch/' + deckId
  expect((await start(path, 1001)).status).toBe(400)
  const original = send.getMockImplementation()!
  send.mockImplementationOnce(original)
  const release = holdNextRequest()
  let taskId: string
  try {
    const started = await start(path, 1000)
    expect(started.status).toBe(202)
    taskId = (await started.json()).id
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(await readJob(path)).toMatchObject({ total: 1000, succeeded: 5, status: 'running' })
    expect((await start(path, 1000, taskId)).status).toBe(429)
    const cancelled = await api(path + '/cancel', { jobId: taskId })
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', succeeded: 5, processed: 5 })
  } finally { release() }
  await vi.waitFor(async () => expect(await plan(path)).toMatchObject({ missing: 996, job: { status: 'cancelled' } }))
  expect(send).toHaveBeenCalledTimes(2)
})

test('processes all 1000 words after one confirmation, in bounded requests', async () => {
  const { id: deckId } = await deck()
  seed(deckId, 1000)
  const path = 'vocabulary/batch/' + deckId
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const original = send.getMockImplementation()!
  send.mockImplementation(async (...args) => {
    // Simulate six seconds per provider request without making the test wait.
    now += 6000
    return original(...args)
  })
  try {
    expect((await start(path, 1000)).status).toBe(202)
    await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
    expect(await plan(path)).toMatchObject({ missing: 0, job: { processed: 1000, succeeded: 1000 } })
    expect(send).toHaveBeenCalledTimes(200)
  } finally {
    send.mockImplementation(original)
    clock.mockRestore()
  }
})

test('shows an interrupted task after restart and retries only words that remain missing', async () => {
  const { id: deckId } = await deck()
  const first = await word(deckId, 'thread')
  const second = await word(deckId, 'queue')
  const path = 'vocabulary/batch/' + deckId
  expect((await start(path, 1)).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  const original = await readJob(path)
  const saved = snapshot(second.id)
  // Simulate an exit after committing the first group.
  db.prepare('UPDATE vocabulary_jobs SET body=? WHERE deck_id=?')
    .run(JSON.stringify({ ...original, total: 2, status: 'running', targets: [select(second), select(first)] }), deckId)
  db.close()
  db = openDatabase(directory)
  app = create()
  expect(await readJob(path)).toMatchObject({ status: 'interrupted', processed: 1, succeeded: 1 })
  expect(db.prepare("SELECT json_extract(body, '$.status') FROM vocabulary_jobs").pluck().get()).toBe('interrupted')
  expect((await start(path, 1, original.id)).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect(snapshot(second.id)).toEqual(saved)
  expect(snapshot(first.id)).toMatchObject({ meaningSource: 'ai', revision: 2 })
  expect(send).toHaveBeenCalledTimes(2)
})

test('reports text authorization failure separately and refuses archived work', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread')
  const path = 'vocabulary/batch/' + deckId
  send.mockImplementationOnce(async () => new Response(null, { status: 403 }))
  expect((await start(path, 1)).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('failed'))
  expect(await (await api('vocabulary/status')).json()).toMatchObject({ status: 'auth' })
  expect(await (await api('speech/settings')).json()).toMatchObject({ credentialStatus: 'configured' })
  expect(snapshot(entry.id)).toEqual(entry)
  await library('archive-deck', [deckId, true, 1])
  expect((await start(path, 1, (await readJob(path)).id)).status).toBe(409)
  expect(send).toHaveBeenCalledTimes(1)
})

async function seedEcdict() {
  const csv = join(directory, 'dictionary-fixture.csv')
  writeFileSync(csv,
    'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n' +
    'banana,bəˈnɑːnə,,n. 香蕉,n.,,,,,,,,\n' +
    'spring,sprɪŋ,,n. 春天,n.,,,,,,,,\n')
  await importEcdictCsv(directory, csv, 'test-ecdict-source')
}

test('ECDICT API is protected, uses readonly lookup, and handles missing and installed states', async () => {
  expect((await api('dictionary/status', undefined, { Cookie: '' })).status).toBe(401)
  expect((await api('dictionary/lookup', { term: 'banana' }, { Origin: 'https://other.invalid' })).status).toBe(403)
  expect(await (await api('dictionary/status')).json()).toMatchObject({ installed: false, wordCount: 0 })
  await seedEcdict()
  expect(await (await api('dictionary/status')).json()).toMatchObject({
    installed: true, wordCount: 2, sourceCommit: 'test-ecdict-source',
  })
  expect(await (await api('dictionary/lookup', { term: 'banana' })).json()).toMatchObject({
    found: true, match: 'exact', suggestedMeaning: '香蕉', needsReview: false,
  })
  expect(await (await api('dictionary/lookup-batch', { terms: ['banana', 'absent'] })).json()).toMatchObject([
    { found: true, suggestedMeaning: '香蕉' }, { found: false, match: 'none' },
  ])
  expect((await api('dictionary/lookup', { term: '../../etc/passwd' })).status).toBe(200)
  expect((await api('dictionary/lookup', { term: '\n' })).status).toBe(400)
  expect((await api('dictionary/lookup-batch', { terms: Array(51).fill('banana') })).status).toBe(400)
})

test('batch saves clear ECDICT meanings and sends only contextual words to MiniMax', async () => {
  await seedEcdict()
  const { id: deckId } = await deck()
  const first = await word(deckId, 'banana')
  const ambiguous = await word(deckId, 'spring')
  const path = 'vocabulary/batch/' + deckId
  expect((await start(path, 2)).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect((await readJob(path)).error).toBeUndefined()
  expect(await readJob(path)).toMatchObject({
    processed: 2, succeeded: 2, dictionarySaved: 1, aiSaved: 1, failed: 0, notFound: 0,
  })
  expect(snapshot(first.id)).toMatchObject({
    term: 'banana', meaning: '香蕉', meaningSource: 'dictionary', phonetic: 'bəˈnɑːnə',
  })
  expect(snapshot(ambiguous.id)).toMatchObject({
    term: 'spring', meaning: '线程', meaningSource: 'ai', phonetic: 'sprɪŋ',
  })
  expect(send).toHaveBeenCalledTimes(1)
  const request = JSON.parse(String(send.mock.calls[0]?.[1]?.body))
  const prompt = JSON.parse(request.messages[1].content)
  expect(prompt.words).toContainEqual(expect.objectContaining({
    term: 'spring', dictionaryHints: expect.objectContaining({ translation: 'n. 春天' }),
  }))
  const exported = await (await api('backup/library?args=%5Bnull%5D')).json()
  expect(exported.data.entries).toContainEqual(expect.objectContaining({
    id: first.id, meaningSource: 'dictionary',
  }))
  expect(db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
  expect(db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
})

test('ECDICT works without MiniMax key; unclear meanings remain untouched', async () => {
  await seedEcdict()
  createSpeechCredentials(db, directory).clear(headers['X-Lexyn-Owner'])
  const { id: deckId } = await deck()
  const clear = await word(deckId, 'banana')
  const ambiguous = await word(deckId, 'spring')
  const path = 'vocabulary/batch/' + deckId
  expect((await start(path, 2)).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect(await readJob(path)).toMatchObject({
    succeeded: 1, dictionarySaved: 1, aiSaved: 0, failed: 1,
  })
  expect(snapshot(clear.id)).toMatchObject({ meaning: '香蕉', meaningSource: 'dictionary' })
  expect(snapshot(ambiguous.id)).toMatchObject({ meaning: '', revision: 1 })
  expect(send).toHaveBeenCalledTimes(0)
})
