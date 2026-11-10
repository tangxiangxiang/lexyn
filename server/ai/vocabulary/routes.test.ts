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
import { createEcdict } from '../../dictionary/ecdict.ts'
import { createStudyStore } from '../../study/store.ts'

const origin = 'http://127.0.0.1:3000'
const password = 'test-owner-password'
const key = 'fake-credential-for-tests'
let directory: string
let db: ReturnType<typeof openDatabase>
let app: ReturnType<typeof createApp>
let headers: Record<string, string>

function aiReply(init?: RequestInit, phonetics?: { british?: string | null; american?: string | null }) {
  const { messages } = JSON.parse(String(init?.body))
  const { words } = JSON.parse(messages[1].content) as { words: { ref: number; term: string }[] }
  const results = words.map(({ ref, term }) => term === 'missing'
    ? { ref, term, senses: [], needsReview: true, warning: '无法确定可靠释义' }
    : { ref, term, senses: [
      { partOfSpeech: 'n.', definitions: [term === 'thread' ? 'C 版本的执行线程' : `${term} 的完整含义`] },
      { partOfSpeech: 'vt.', definitions: ['整理并说明'] },
    ], phonetics, needsReview: false, warning: null })
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] })
}
const send = vi.fn<typeof fetch>(async (_url, init) => aiReply(init))
const create = () => createApp(db, undefined, origin, Date.now, undefined, { dataDir: directory }, send)

beforeEach(async () => {
  send.mockReset()
  send.mockImplementation(async (_url, init) => aiReply(init))
  directory = mkdtempSync(join(tmpdir(), 'lexyn-vocabulary-test-'))
  db = openDatabase(directory)
  await initializeOwner(db, 'test-admin', password)
  app = create()
  const login = await app.request('/api/auth/login', { method: 'POST',
    headers: { 'X-Lexyn-Client': '1', 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'test-admin', password }) })
  const { session } = await login.json()
  headers = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId,
    Cookie: login.headers.get('Set-Cookie')!.split(';')[0], Origin: origin, 'Content-Type': 'application/json' }
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
const word = (deckId: string, term: string, meaning = '') => library<Entry>('create-entry', [deckId, { term, meaning }])
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

async function seedEcdict() {
  const csv = join(directory, 'dictionary-fixture.csv')
  writeFileSync(csv,
    'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n' +
    'banana,bəˈnɑːnə,fruit,n. 香蕉,n.,,,,,,,,\n' +
    'thread,θred,a thin cord,n. 线\\nvt. 穿线,v.,,,,,,,,\n')
  await importEcdictCsv(directory, csv, 'test-ecdict-source')
}

test('requires Owner and origin; FSRS and PracticeEvent tables are independent of vocabulary generation', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', '旧版本释义')
  expect((await api('vocabulary/status', undefined, { Cookie: '' })).status).toBe(401)
  expect((await api(`vocabulary/optimize/${entry.id}`, { revision: entry.revision }, { Origin: 'https://elsewhere.invalid' })).status).toBe(403)
  expect((await api(`vocabulary/optimize/${entry.id}`, { revision: entry.revision + 1 })).status).toBe(409)
  expect((await api(`vocabulary/optimize/${entry.id}`, { revision: entry.revision })).status).toBe(200)
  expect(snapshot(entry.id)).toMatchObject({ revision: 2, meaningSource: 'ai', meaning: 'n. C 版本的执行线程\nvt. 整理并说明' })
  expect(send).toHaveBeenCalledTimes(1)
  const request = JSON.parse(String(send.mock.calls[0]?.[1]?.body))
  expect(JSON.parse(request.messages[1].content).words[0].currentMeaning.text).toBe('旧版本释义')
  expect(db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(0)
  expect(db.prepare('SELECT count(*) FROM practice_events').pluck().get()).toBe(0)
  expect(await (await api('vocabulary/status')).json()).toMatchObject({ status: 'available' })
})

test('ECDICT original data stays immutable while each AI iteration uses the latest saved meaning', async () => {
  await seedEcdict()
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread')
  const auto = await api(`vocabulary/auto/${entry.id}`, { revision: entry.revision })
  expect(auto.status).toBe(202)
  await vi.waitFor(() => expect(snapshot(entry.id).dictionaryMeaning?.model).toBe('MiniMax-M3.1-Flash'))
  const versionA = snapshot(entry.id)
  expect(versionA.dictionaryReference).toEqual({ sourceWord: 'thread', sourceRevision: 'test-ecdict-source',
    translation: 'n. 线\\nvt. 穿线', definition: 'a thin cord', partOfSpeech: 'v.', phonetic: 'θred' })
  expect(versionA.phonetics).toBeUndefined()
  const dictionary = createEcdict(directory)
  expect(dictionary.lookup('thread').entries[0]?.translation).toBe('n. 线\\nvt. 穿线')
  dictionary.close()
  const manualMeaning = { senses: [{ partOfSpeech: 'n.', definitions: ['人工编辑的版本 B'], source: 'manual' }] }
  const savedB = await library<Entry>('update-entry', [deckId, entry.id, { term: 'thread', meaning: 'n. 人工编辑的版本 B', dictionaryMeaning: manualMeaning }, versionA.revision])
  expect(savedB.meaning).toBe('n. 人工编辑的版本 B')
  const response = await api(`vocabulary/optimize/${entry.id}`, { revision: savedB.revision })
  expect(response.status).toBe(200)
  const prompt = JSON.parse(JSON.parse(String(send.mock.calls.at(-1)?.[1]?.body)).messages[1].content)
  expect(prompt.words[0].currentMeaning.text).toBe('n. 人工编辑的版本 B')
  expect(snapshot(entry.id)).toMatchObject({ meaning: 'n. C 版本的执行线程\nvt. 整理并说明', revision: savedB.revision + 1 })
  expect(snapshot(entry.id).dictionaryReference).toEqual(versionA.dictionaryReference)
  const dictionaryAfter = createEcdict(directory)
  expect(dictionaryAfter.lookup('thread').entries[0]?.translation).toBe(versionA.dictionaryReference?.translation)
  dictionaryAfter.close()
})

test('a case-folded ECDICT match is retained as an AI reference for a differently cased term', async () => {
  await seedEcdict()
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'THREAD')
  expect((await api(`vocabulary/auto/${entry.id}`, { revision: entry.revision })).status).toBe(202)
  await vi.waitFor(() => expect(snapshot(entry.id).dictionaryReference?.sourceWord).toBe('thread'))
  expect(snapshot(entry.id).dictionaryReference).toMatchObject({
    sourceWord: 'thread', sourceRevision: 'test-ecdict-source', translation: 'n. 线\\nvt. 穿线',
  })
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).messages[1].content).toContain('THREAD')
})

test('a failed optimization preserves the latest human meaning and dictionary reference', async () => {
  await seedEcdict()
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', '人工版本 B')
  const saved = { ...entry, phonetics: { british: 'θred', american: 'θɹɛd' },
    dictionaryReference: { sourceWord: 'thread', sourceRevision: 'fixture',
    translation: 'n. 原始词典文本', definition: 'original definition', partOfSpeech: 'n.', phonetic: 'θred' } }
  createStudyStore(db, headers['X-Lexyn-Owner']).saveEntry(saved)
  send.mockImplementationOnce(async () => new Response(null, { status: 500 }))
  expect((await api(`vocabulary/optimize/${entry.id}`, { revision: entry.revision })).status).toBe(502)
  expect(snapshot(entry.id)).toEqual(saved)
})

test('IPA optimization uses saved edits, preserves null accents and respects an explicit clear', async () => {
  await seedEcdict()
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', '用户释义')
  const phonetics = { british: '/θred/', american: '/θɹɛd/', unspecified: 'θred' }
  const edited = await library<Entry>('update-entry', [deckId, entry.id, {
    term: 'thread', meaning: entry.meaning, phonetics, phonetic: 'θred',
  }, entry.revision])
  send.mockImplementationOnce(async (_url, init) => aiReply(init, { british: 'θɹed', american: null }))
  expect((await api(`vocabulary/optimize/${entry.id}`, { revision: edited.revision })).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(1)
  const prompt = JSON.parse(JSON.parse(String(send.mock.calls[0][1]?.body)).messages[1].content)
  expect(prompt.words[0]).toMatchObject({ currentPhonetics: phonetics, dictionaryReference: { phonetic: 'θred' } })
  const optimized = snapshot(entry.id)
  expect(optimized).toMatchObject({ phonetic: 'θred', phonetics: { ...phonetics, british: 'θɹed' },
    meaningSource: 'ai', revision: edited.revision + 1 })

  const cleared = await library<Entry>('update-entry', [deckId, entry.id, {
    term: 'thread', meaning: optimized.meaning, phonetics: null, phonetic: '',
  }, optimized.revision])
  send.mockImplementationOnce(async (_url, init) => aiReply(init, { british: null, american: null }))
  expect((await api(`vocabulary/optimize/${entry.id}`, { revision: cleared.revision })).status).toBe(200)
  expect(snapshot(entry.id).phonetics).toBeUndefined()
  expect(snapshot(entry.id).phonetic).toBeUndefined()
  expect(snapshot(entry.id).dictionaryReference?.phonetic).toBe('θred')
})

test('an older AI response cannot overwrite a newer revision', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', '版本 A')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  send.mockImplementationOnce(async (_url, init) => { await gate; return aiReply(init, { british: 'θɹed' }) })
  const pending = api(`vocabulary/optimize/${entry.id}`, { revision: entry.revision })
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  const newer = await library<Entry>('update-entry', [deckId, entry.id,
    { term: 'thread', meaning: '用户后来保存的版本 B', phonetics: { british: '/θred/' } }, entry.revision])
  release()
  expect((await pending).status).toBe(409)
  expect(snapshot(entry.id)).toEqual(newer)
})

test('an in-flight result for the old spelling cannot attach to a renamed entry', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', '线程')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  send.mockImplementationOnce(async (_url, init) => { await gate; return aiReply(init) })
  const pending = api(`vocabulary/optimize/${entry.id}`, { revision: entry.revision })
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

  const renamed = await library<Entry>('update-entry', [deckId, entry.id, {
    term: 'queue', meaning: '线程',
    dictionaryMeaning: { senses: [{ partOfSpeech: 'n.', definitions: ['线程'], source: 'manual' }] },
    dictionaryReference: { sourceWord: 'thread', sourceRevision: 'fixture', translation: 'n. 线程',
      definition: 'a thin cord', partOfSpeech: 'n.', phonetic: 'θred' },
    phonetics: { british: '/θred/', american: '/θrɛd/' },
  }, entry.revision])
  expect(renamed).toMatchObject({ term: 'queue', meaning: '', revision: entry.revision + 1 })
  expect(renamed.dictionaryMeaning).toBeUndefined()
  expect(renamed.dictionaryReference).toBeUndefined()
  expect(renamed.phonetics).toBeUndefined()

  release()
  expect((await pending).status).toBe(409)
  expect(snapshot(entry.id)).toEqual(renamed)
})

test('repeated automatic requests share one AI call and keep a word saved if generation fails', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  send.mockImplementationOnce(async (_url, init) => { await gate; return aiReply(init) })
  expect((await api(`vocabulary/auto/${entry.id}`, { revision: entry.revision })).status).toBe(202)
  expect((await api(`vocabulary/auto/${entry.id}`, { revision: entry.revision })).status).toBe(202)
  expect(send).toHaveBeenCalledTimes(1)
  release()
  await vi.waitFor(() => expect(snapshot(entry.id).revision).toBe(2))

  send.mockImplementationOnce(async () => new Response(null, { status: 500 }))
  const next = await word(deckId, 'second')
  expect((await api(`vocabulary/auto/${next.id}`, { revision: next.revision })).status).toBe(202)
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(snapshot(next.id).meaning).toBe(''))
  expect(snapshot(next.id)).toMatchObject({ term: 'second', revision: 1, meaning: '' })
})

test('automatic generation iterates from a meaning entered with a new word', async () => {
  const { id: deckId } = await deck()
  const entry = await word(deckId, 'thread', 'n. 用户初始释义')
  expect(entry.meaningSource).toBe('manual')
  expect((await api(`vocabulary/auto/${entry.id}`, { revision: entry.revision })).status).toBe(202)
  await vi.waitFor(() => expect(snapshot(entry.id).revision).toBe(2))
  const request = JSON.parse(String(send.mock.calls[0]?.[1]?.body))
  expect(JSON.parse(request.messages[1].content).words[0].currentMeaning.text).toBe('n. 用户初始释义')
  expect(snapshot(entry.id)).toMatchObject({ meaning: 'n. C 版本的执行线程\nvt. 整理并说明', meaningSource: 'ai' })
})

test('batch sends every selected term through AI and stores full structured meanings plus dictionary references', async () => {
  await seedEcdict()
  const { id: deckId } = await deck()
  const first = await word(deckId, 'banana')
  const second = await word(deckId, 'thread', '先前手写释义')
  const missing = await word(deckId, 'missing')
  const path = `vocabulary/batch/${deckId}`
  expect(await plan(path)).toMatchObject({ missing: 3, limit: 1000 })
  const requestId = randomUUID()
  expect((await start(path, 3, null, requestId)).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect(await readJob(path)).toMatchObject({ processed: 3, succeeded: 2, failed: 1, aiSaved: 2, dictionarySaved: 2, notFound: 1 })
  expect(snapshot(first.id)).toMatchObject({ meaning: 'n. banana 的完整含义\nvt. 整理并说明', revision: 2,
    dictionaryReference: { sourceWord: 'banana', sourceRevision: 'test-ecdict-source', translation: 'n. 香蕉', phonetic: 'bəˈnɑːnə' } })
  expect(snapshot(second.id).meaning).toContain('C 版本的执行线程')
  expect(snapshot(second.id).meaning).not.toBe(second.meaning)
  expect(snapshot(missing.id)).toEqual(missing)
  expect(send).toHaveBeenCalledTimes(1)
  const request = JSON.parse(String(send.mock.calls[0]?.[1]?.body))
  const words = JSON.parse(request.messages[1].content).words
  expect(words.find((row: { term: string }) => row.term === 'thread').currentMeaning.text).toBe('先前手写释义')
  expect(words.find((row: { term: string }) => row.term === 'banana').dictionaryReference.translation).toBe('n. 香蕉')
  expect((await plan(path)).missing).toBe(1)
})

test('batch task stays bounded, cancelable, resumable, and requires MiniMax credentials', async () => {
  const { id: deckId } = await deck()
  seed(deckId, 20)
  const path = `vocabulary/batch/${deckId}`
  expect((await start(path, 1001)).status).toBe(400)
  const owner = headers['X-Lexyn-Owner']
  createSpeechCredentials(db, directory).clear(owner)
  expect((await start(path, 20)).status).toBe(503)
  createSpeechCredentials(db, directory).save(owner, key)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  send.mockImplementationOnce(async (_url, init) => { await gate; return aiReply(init) })
  const started = await start(path, 20)
  expect(started.status).toBe(202)
  const jobId = (await started.json()).id
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  const cancelled = await api(path + '/cancel', { jobId })
  expect(await cancelled.json()).toMatchObject({ status: 'cancelled', processed: 0 })
  release()
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('cancelled'))
})

test('IPA backfill keeps existing accents and excludes complete words from later work', async () => {
  const { id: deckId } = await deck()
  const entry = await library<Entry>('create-entry', [deckId, {
    term: 'command', meaning: 'n. 命令；指令',
    dictionaryMeaning: { senses: [{ partOfSpeech: 'n.', definitions: ['命令', '指令'], source: 'manual' }] },
    phonetics: { british: '/kəˈmɑːnd/', unspecified: 'kəˈmɑːnd' },
  }])
  await library('create-entry', [deckId, {
    term: 'bed', meaning: '床', phonetics: { british: 'bed', american: 'bed' },
  }])
  await word(deckId, 'blank')
  const path = `vocabulary/batch/${deckId}`
  expect(await plan(path)).toMatchObject({ missingPhonetics: 1 })
  send.mockImplementationOnce(async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ results: [{ ref: 0, term: 'command',
      phonetics: { british: 'kəˈmænd', american: 'kəˈmænd' }, needsReview: true, warning: null }] }),
  } }] }))
  const requestId = randomUUID()
  expect((await api(path, { requestId, count: 3, afterTaskId: null, mode: 'phonetics' })).status).toBe(202)
  await vi.waitFor(async () => expect((await readJob(path)).status).toBe('completed'))
  expect(await readJob(path)).toMatchObject({ mode: 'phonetics', total: 1, succeeded: 1, needsReview: 1 })
  expect(snapshot(entry.id)).toMatchObject({
    dictionaryMeaning: entry.dictionaryMeaning, meaning: entry.meaning, meaningSource: entry.meaningSource,
    phonetics: { ...entry.phonetics, american: 'kəˈmænd' }, revision: entry.revision + 1,
  })
  expect(await plan(path)).toMatchObject({ missingPhonetics: 0 })
  expect((await api(path, { requestId: randomUUID(), count: 3, afterTaskId: requestId, mode: 'phonetics' })).status).toBe(409)
  expect(send).toHaveBeenCalledTimes(1)
})

test('ECDICT API remains protected and lookup is read-only', async () => {
  expect((await api('dictionary/status', undefined, { Cookie: '' })).status).toBe(401)
  expect((await api('dictionary/lookup', { term: 'banana' }, { Origin: 'https://other.invalid' })).status).toBe(403)
  expect(await (await api('dictionary/status')).json()).toMatchObject({ installed: false, wordCount: 0 })
  await seedEcdict()
  expect(await (await api('dictionary/status')).json()).toMatchObject({ installed: true, wordCount: 2, sourceCommit: 'test-ecdict-source' })
  expect(await (await api('dictionary/lookup', { term: 'banana' })).json()).toMatchObject({
    found: true, match: 'exact', entries: [{ translation: 'n. 香蕉' }], needsReview: false,
  })
  expect((await api('dictionary/lookup', { term: '\n' })).status).toBe(400)
})
