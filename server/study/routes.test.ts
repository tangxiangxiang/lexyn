import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'
import { initializeOwner } from '../auth/owner.ts'
import { migrate } from '../db/migrations/index.ts'
import { reviewRatings } from '../../shared/domain/review.ts'
import { createReviewScheduler, rebuildCardFromEvents, schedulerGrades, serializeCard } from '../../shared/srs/scheduler.ts'
import { dayBounds, reviewDayBounds } from './calendar.ts'

const origin = 'http://127.0.0.1:3000'
const initial = Date.parse('2026-11-10T15:59:59Z')
let now: number
let db: Database.Database
let app: ReturnType<typeof createApp>
let auth: Record<string, string>

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  migrate(db)
  now = initial
  const password = 'test-owner-password'
  await initializeOwner(db, 'test-admin', password)
  app = createApp(db, undefined, origin, () => now)
  const login = await app.request('/api/auth/login', { method: 'POST', headers: {
    'X-Lexyn-Client': '1', 'Content-Type': 'application/json', Origin: origin,
  }, body: JSON.stringify({ username: 'test-admin', password }) })
  const { session } = await login.json()
  auth = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId, Cookie: login.headers.get('Set-Cookie')!.split(';')[0] }
})
afterEach(() => db.close())

function get(path: string, args: unknown[] = []) {
  return app.request('/api/' + path + '?args=' + encodeURIComponent(JSON.stringify(args)), { headers: auth })
}
function post(path: string, args: unknown[], key: string = randomUUID(), headers = auth) {
  return app.request('/api/' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
    'Idempotency-Key': key, ...headers }, body: JSON.stringify(args) })
}
async function data(result: Response | Promise<Response>) {
  const response = await result
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return body.data
}
const count = (table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()

async function setupLearn(meaning = '缓存') {
  const deck = await data(post('library/create-deck', [{ name: 'Systems' }]))
  const entry = await data(post('library/create-entry', [deck.id, { term: 'cache', meaning }]))
  const session = await data(post('learn/start', [deck.id, 'copy', [entry.id], true]))
  await data(post('learn/attempt', [session.sessionId, entry.id, 'cache', session.revision]))
  return { deck, entry, session: (await data(get('learn/session', [session.sessionId]))).session }
}
async function setupReview() {
  const { deck, entry, session } = await setupLearn()
  await data(post('learn/finish', [session.sessionId, entry.id, 'completed', session.revision]))
  await data(post('review/start', [deck.id]))
  const front = await data(get('review/session', [deck.id]))
  expect(front.word).toEqual({ card: false, entryRevision: 1, prompt: '缓存' })
  await data(post('review/reveal', [front.session.sessionId, front.session.currentCardId, entry.revision, front.session.revision]))
  const back = await data(get('review/session', [deck.id]))
  expect(back.word.answer.term).toBe('cache')
  return back.session
}

test('authenticates private reads and writes, rejects bad origin and invalid input', async () => {
  for (const path of ['library/decks', 'learn/daily', 'review/overview', 'progress/overview', 'settings/owner', 'backup/library']) {
    const res = await app.request('/api/' + path, { headers: { 'X-Lexyn-Client': '1' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  }
  expect((await post('library/create-deck', [{ name: 'bad' }], randomUUID(), { ...auth, Origin: 'https://invalid.example' })).status).toBe(403)
  expect((await post('library/create-deck', [{ name: 'bad' }], randomUUID(), { ...auth, Cookie: 'lexyn-session=invalid' })).status).toBe(401)
  expect((await post('library/create-deck', [{ name: 'bad', id: randomUUID() }])).status).toBe(400)
  expect((await post('settings/timezone', ['+08:00'])).status).toBe(400)
  expect(count('decks')).toBe(0)
  expect(count('request_idempotency')).toBe(0)
})

test('normalizes unique spelling and rolls back a batch when a later preview match is stale', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Systems' }]))
  const entry = await data(post('library/create-entry', [deck.id, { term: ' Café ', meaning: '咖啡' }]))
  expect(entry.normalizedTerm).toBe('café')
  expect((await post('library/create-entry', [deck.id, { term: 'CAFE\u0301', meaning: '' }])).status).toBe(409)
  const key = randomUUID()
  const preview = [
    { input: { term: 'new' }, normalizedTerm: 'new' },
    { input: { term: 'café' }, normalizedTerm: 'café', match: { id: entry.id, revision: 2 } },
  ]
  expect((await post('library/import', [deck.id, preview, 'overwrite'], key)).status).toBe(409)
  expect(count('entries')).toBe(1)
  await data(post('library/import', [deck.id, [preview[0]], 'skip'], key))
  expect(count('entries')).toBe(2)
  expect((await post('library/import', [deck.id, [], 'skip'], key)).status).toBe(409)
  expect((await data(get('library/deck', [deck.id, 'CAFÉ', 'active', 0, 1]))).entries).toMatchObject([entry])
})

test('CSV overwrite replaces a structured meaning only for non-empty changed text and preserves same-word data', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Systems' }]))
  const aiMeaning = { senses: [
    { partOfSpeech: 'n.', definitions: ['线程', '线索'], source: 'ai' },
    { partOfSpeech: 'vt.', definitions: ['穿线'], source: 'ai' },
  ] }
  const reference = { sourceWord: 'thread', sourceRevision: 'ecdict-fixture', translation: 'n. 原始词典释义',
    definition: 'a thin cord', partOfSpeech: 'n.', phonetic: 'θred' }
  const phonetics = { british: '/θred/', american: '/θrɛd/' }
  const original = await data(post('library/create-entry', [deck.id, {
    term: 'thread', meaning: 'n. 线程；线索\nvt. 穿线', dictionaryMeaning: aiMeaning,
    dictionaryReference: reference, phonetics, phonetic: '/θred/', meaningSource: 'ai', meaningNeedsReview: true,
    example: 'A legacy example.', note: 'A legacy note.', pronunciationOverride: 'th red',
  }]))
  const csv = 'term,meaning,example\nthread,螺纹；线,Do not import example columns'
  const preview = await data(post('library/import-preview', [deck.id, csv, 'csv', 'auto', { term: 0, meaning: 1 }]))
  expect(preview.candidates[0].input).toEqual({ term: 'thread', meaning: '螺纹；线' })
  const result = await data(post('library/import', [deck.id, preview.candidates, 'overwrite']))
  expect(result).toEqual({ added: 0, updated: 1, skipped: 0 })
  let entry = (await data(get('library/deck', [deck.id, '', 'active', 0, 20]))).entries[0]
  expect(entry).toMatchObject({
    meaning: '螺纹；线', meaningSource: 'manual',
    dictionaryMeaning: { senses: [{ partOfSpeech: '', definitions: ['螺纹；线'], source: 'manual' }] },
    dictionaryReference: reference, phonetics, phonetic: '/θred/',
    example: 'A legacy example.', note: 'A legacy note.', pronunciationOverride: 'th red', revision: original.revision + 1,
  })
  expect(entry.meaningNeedsReview).toBeUndefined()

  const noMeaningSource = 'term,example,note\nthread,Ignored example,Ignored note'
  const unmapped = await data(post('library/import-preview', [deck.id, noMeaningSource, 'csv', 'auto', { term: 0 }]))
  expect(unmapped.candidates[0].input).toEqual({ term: 'thread' })
  await data(post('library/import', [deck.id, unmapped.candidates, 'overwrite']))
  entry = (await data(get('library/deck', [deck.id, '', 'active', 0, 20]))).entries[0]
  expect(entry.meaning).toBe('螺纹；线')
  expect(entry.dictionaryMeaning).toEqual({ senses: [{ partOfSpeech: '', definitions: ['螺纹；线'], source: 'manual' }] })
  expect(entry.example).toBe('A legacy example.')
  expect(entry.note).toBe('A legacy note.')

  const blank = await data(post('library/import-preview', [deck.id, 'term,meaning\nthread,', 'csv', 'auto', { term: 0, meaning: 1 }]))
  await data(post('library/import', [deck.id, blank.candidates, 'overwrite']))
  const afterBlank = (await data(get('library/deck', [deck.id, '', 'active', 0, 20]))).entries[0]
  expect(afterBlank.meaning).toBe('螺纹；线')
  expect(afterBlank.dictionaryMeaning).toEqual(entry.dictionaryMeaning)

  const sameText = await data(post('library/import-preview', [deck.id, 'term,meaning\nthread,螺纹；线', 'csv', 'auto', { term: 0, meaning: 1 }]))
  await data(post('library/import', [deck.id, sameText.candidates, 'overwrite']))
  const afterSame = (await data(get('library/deck', [deck.id, '', 'active', 0, 20]))).entries[0]
  expect(afterSame.dictionaryMeaning).toEqual(entry.dictionaryMeaning)
  const beforeSkip = afterSame
  const skipPreview = await data(post('library/import-preview', [deck.id, 'term,meaning\nthread,螺纹；线', 'csv', 'auto', { term: 0, meaning: 1 }]))
  await data(post('library/import', [deck.id, skipPreview.candidates, 'skip']))
  const afterSkip = (await data(get('library/deck', [deck.id, '', 'active', 0, 20]))).entries[0]
  expect(afterSkip).toEqual(beforeSkip)

  const longText = 'definition '.repeat(110)
  const longPreview = await data(post('library/import-preview', [deck.id,
    `term,meaning\nlong-prose,"${longText.trim()}"`, 'csv', 'auto', { term: 0, meaning: 1 }]))
  await data(post('library/import', [deck.id, longPreview.candidates, 'overwrite']))
  const longEntry = (await data(get('library/deck', [deck.id, 'long-prose', 'active', 0, 20]))).entries[0]
  expect(longEntry.meaning).toBe(longText.trim())
  expect(longEntry.dictionaryMeaning).toBeUndefined()
  expect(longEntry.meaningSource).toBe('manual')
})

test('saving a different spelling clears old term data but preserves FSRS history and enforces revision', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Systems' }]))
  const dictionaryMeaning = { senses: [{ partOfSpeech: 'n.', definitions: ['线程'], source: 'manual' }] }
  const dictionaryReference = { sourceWord: 'thread', sourceRevision: 'ecdict-fixture', translation: 'n. 原始释义',
    definition: 'a thin cord', partOfSpeech: 'n.', phonetic: 'θred' }
  const phonetics = { british: '/θred/', american: '/θrɛd/', unspecified: 'thred' }
  const entry = await data(post('library/create-entry', [deck.id, {
    term: 'thread', meaning: 'n. 线程', dictionaryMeaning, dictionaryReference, phonetics, phonetic: 'thred',
    pronunciationOverride: 'th red',
  }]))
  const learn = await data(post('learn/start', [deck.id, 'copy', [entry.id], true]))
  await data(post('learn/attempt', [learn.sessionId, entry.id, 'thread', learn.revision]))
  const attempted = (await data(get('learn/session', [learn.sessionId]))).session
  await data(post('learn/finish', [learn.sessionId, entry.id, 'completed', attempted.revision]))
  await data(post('review/start', [deck.id]))
  const front = await data(get('review/session', [deck.id]))
  await data(post('review/reveal', [front.session.sessionId, front.session.currentCardId, entry.revision, front.session.revision]))
  const back = await data(get('review/session', [deck.id]))
  await data(post('review/score', [back.session.sessionId, back.session.currentCardId, 'good', back.session.revision]))
  const cardBefore = db.prepare('SELECT body FROM review_cards WHERE entry_id=?').pluck().get(entry.id)
  expect(count('review_events')).toBe(1)

  const changed = await data(post('library/update-entry', [deck.id, entry.id, {
    term: 'queue', meaning: entry.meaning, dictionaryMeaning, dictionaryReference, phonetics,
    phonetic: 'thred', pronunciationOverride: 'th red',
  }, entry.revision]))
  expect(changed).toMatchObject({ term: 'queue', meaning: '', revision: entry.revision + 1, termChangedAt: now })
  expect(changed.dictionaryMeaning).toBeUndefined()
  expect(changed.dictionaryReference).toBeUndefined()
  expect(changed.phonetics).toBeUndefined()
  expect(changed.phonetic).toBeUndefined()
  expect(changed.pronunciationOverride).toBeUndefined()
  expect(db.prepare('SELECT body FROM review_cards WHERE entry_id=?').pluck().get(entry.id)).toBe(cardBefore)
  expect(count('review_events')).toBe(1)

  expect((await post('library/update-entry', [deck.id, entry.id, { term: 'thread', meaning: '旧释义' }, entry.revision])).status).toBe(409)
  expect((await data(get('library/deck', [deck.id, '', 'active', 0, 20]))).entries[0]).toEqual(changed)
})

test('commits PracticeEvent, progress, session and receipt together and enforces one shared quota', async () => {
  await data(post('settings/daily', [1]))
  await data(post('settings/timezone', ['Asia/Shanghai']))
  const { deck, entry, session } = await setupLearn()
  const other = await data(post('library/create-entry', [deck.id, { term: 'latch', meaning: '闩锁' }]))
  const args = [session.sessionId, entry.id, 'completed', session.revision]
  const key = randomUUID()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON request_idempotency BEGIN SELECT RAISE(ABORT, 'receipt fault'); END")
    expect((await post('learn/finish', args, key)).status).toBe(500)
    expect(count('practice_events')).toBe(0)
    expect(count('learn_progress')).toBe(0)
    expect((await data(get('learn/session', [session.sessionId]))).session).toEqual(session)
  } finally { db.exec('DROP TRIGGER fail_receipt'); log.mockRestore() }
  const completed = await data(post('learn/finish', args, key))
  expect(await data(post('learn/finish', args, key))).toEqual(completed)
  expect((await post('learn/finish', args)).status).toBe(409)
  expect(count('practice_events')).toBe(1)
  expect(count('review_cards')).toBe(0)
  expect((await post('learn/start', [deck.id, 'copy', [other.id], true])).status).toBe(409)
  const listOverview = await data(get('progress/overview'))
  expect(listOverview).toMatchObject({ learnedToday: 1, firstRecall: 1, ratedToday: 0 })
  const { lists } = await data(get('library/lists', [deck.id]))
  expect(listOverview.listStats).toEqual([expect.objectContaining({ listId: lists[0].id, due: 0, firstRecall: 1 })])
  now += 1000
  expect(await data(get('learn/daily', [deck.id]))).toMatchObject({ completedToday: 0, candidates: [other] })
  expect(await data(get('progress/overview'))).toMatchObject({ learnedToday: 0, firstRecall: 1 })
})

test.each(reviewRatings)('scores %s using FSRS-7 and atomically stores history, projection and session', async (rating) => {
  const round = await setupReview()
  const args = [round.sessionId, round.currentCardId, rating, round.revision]
  const key = randomUUID()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    db.exec("CREATE TRIGGER fail_round BEFORE UPDATE ON review_sessions BEGIN SELECT RAISE(ABORT, 'round fault'); END")
    expect((await post('review/score', args, key)).status).toBe(500)
    expect(count('review_events')).toBe(0)
    expect(count('review_cards')).toBe(0)
    expect((await data(get('review/session', [null]))).session).toEqual(round)
  } finally { db.exec('DROP TRIGGER fail_round'); log.mockRestore() }
  const result = await data(post('review/score', args, key))
  expect(await data(post('review/score', args, key))).toEqual(result)
  expect((await post('review/score', args)).status).toBe(409)
  expect(result.round.session.status).toBe('completed')
  const snapshot = await data(get('backup/library', [null]))
  expect(snapshot.reviewEvents).toHaveLength(1)
  const engine = await createReviewScheduler()
  const time = new Date(now)
  const expected = serializeCard(engine.review({ card: engine.newCard({ now: time, cardId: round.currentCardId }),
    grade: schedulerGrades[rating], now: time }).card)
  expect(snapshot.reviewCards[0].schedulerState).toEqual(expected)
  expect(await rebuildCardFromEvents(snapshot.reviewEvents)).toEqual(expected)
  expect(await data(get('progress/overview'))).toMatchObject({ learnedToday: 1, ratedToday: 1, due: 0, nextDueAt: expected.dueAt })
  now = expected.dueAt
  expect(await data(get('progress/overview'))).toMatchObject({ due: 1 })
})

test('uses calendar days with DST and independent Owner timezones', () => {
  const spring = Date.parse('2026-03-08T15:00:00Z')
  const fall = Date.parse('2026-11-01T15:00:00Z')
  expect(dayBounds(spring, 'America/New_York')).toEqual([Date.parse('2026-03-08T05:00:00Z'), Date.parse('2026-03-09T04:00:00Z')])
  expect(dayBounds(fall, 'America/New_York')).toEqual([Date.parse('2026-11-01T04:00:00Z'), Date.parse('2026-11-02T05:00:00Z')])
  expect(dayBounds(initial, 'Asia/Shanghai')[1]).toBe(initial + 1000)
  expect(dayBounds(initial, 'UTC')[1]).toBe(Date.parse('2026-11-11T00:00:00Z'))
})

test('publishes new word quotas only on the saved study days in the owner timezone', async () => {
  now = Date.parse('2026-11-09T15:59:59Z')
  const deck = await data(post('library/create-deck', [{ name: 'Weekly plan' }]))
  const entry = await data(post('library/create-entry', [deck.id, { term: 'cache', meaning: '缓存' }]))
  await data(post('settings/plan', [30, 126, 210]))
  await data(post('settings/timezone', ['Asia/Shanghai']))
  expect(await data(get('settings/owner'))).toEqual({
    dailyNewWords: 30, timezone: 'Asia/Shanghai', studyWeekdays: 126, reviewResetMinutes: 210,
  })
  expect((await post('settings/plan', [30, 0, 210])).status).toBe(400)
  expect(await data(get('learn/daily', [deck.id]))).toMatchObject({ quota: 0, dailyNewWords: 30, candidates: [] })
  expect((await post('learn/start', [deck.id, 'copy', [entry.id], true])).status).toBe(409)
  now += 1000
  expect(await data(get('learn/daily', [deck.id]))).toMatchObject({ quota: 30, candidates: [{ id: entry.id }] })
})

test('resets review totals at the requested civil time through a skipped or repeated hour', () => {
  const timestamp = (iso: string) => Date.parse(iso)
  expect(reviewDayBounds(timestamp('2026-03-08T08:00:00Z'), 'America/New_York', 150)).toEqual([
    timestamp('2026-03-08T07:00:00Z'), timestamp('2026-03-09T06:30:00Z'),
  ])
  expect(reviewDayBounds(timestamp('2026-11-01T06:00:00Z'), 'America/New_York', 90)).toEqual([
    timestamp('2026-11-01T05:30:00Z'), timestamp('2026-11-02T06:30:00Z'),
  ])
  expect(reviewDayBounds(timestamp('2026-11-11T02:30:00Z'), 'UTC', 210)).toEqual([
    timestamp('2026-11-10T03:30:00Z'), timestamp('2026-11-11T03:30:00Z'),
  ])
})

test('resets the displayed review count without changing the next scheduled review', async () => {
  now = Date.parse('2026-11-11T02:00:00Z')
  await data(post('settings/plan', [10, 127, 210]))
  const review = await setupReview()
  await data(post('review/score', [review.sessionId, review.currentCardId, 'easy', review.revision]))
  const before = await data(get('progress/overview'))
  expect(before).toMatchObject({ ratedToday: 1, learnedToday: 1, due: 0, nextDayAt: Date.parse('2026-11-11T03:30:00Z') })
  now = before.nextDayAt
  expect(await data(get('progress/overview'))).toMatchObject({
    ratedToday: 0, learnedToday: 1, due: 0, nextDueAt: before.nextDueAt,
  })
})

test('rejects premature Learn completion and records Skip without creating progress or consuming quota', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Systems' }]))
  const entry = await data(post('library/create-entry', [deck.id, { term: 'skip', meaning: '跳过' }]))
  const session = await data(post('learn/start', [deck.id, 'dictation', [entry.id], true]))
  const args = [session.sessionId, entry.id, 'completed', session.revision]
  expect((await post('learn/finish', args)).status).toBe(409)
  expect(await data(post('learn/assist', [session.sessionId, entry.id, session.revision]))).toBe(true)
  const assisted = (await data(get('learn/session', [session.sessionId]))).session
  await data(post('learn/finish', [session.sessionId, entry.id, 'skipped', assisted.revision]))
  expect(await data(get('learn/history', [session.sessionId, 0, 1]))).toMatchObject({
    completed: 0, skipped: 1, firstCompleted: 0, assisted: 1,
  })
  expect(await data(get('learn/daily', [deck.id]))).toMatchObject({ completedToday: 0, candidates: [entry] })
  expect(count('learn_progress')).toBe(0)
})

test('uses a single active spelling per deck and rejects restoration while a replacement is active', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Systems' }]))
  const another = await data(post('library/create-deck', [{ name: 'Others' }]))
  const args = { term: 'Café', meaning: '咖啡' }
  const entry = await data(post('library/create-entry', [deck.id, args]))
  await data(post('library/create-entry', [another.id, args]))
  await data(post('library/remove-entry', [deck.id, entry.id, true, entry.revision]))
  await data(post('library/create-entry', [deck.id, args]))
  expect((await post('library/remove-entry', [deck.id, entry.id, false, entry.revision + 1])).status).toBe(409)
  const backup = await data(get('backup/library', [deck.id]))
  expect(backup.decks).toEqual([deck])
  expect(backup.entries).toHaveLength(2)
  expect(backup.entries.filter((word: { deletedAt?: number }) => word.deletedAt !== undefined)).toHaveLength(1)
})

test('excludes unlearned and non-Chinese words from Review', async () => {
  const { deck, entry, session } = await setupLearn('English only')
  await data(post('library/create-entry', [deck.id, { term: 'unlearned', meaning: '未学' }]))
  await data(post('learn/finish', [session.sessionId, entry.id, 'completed', session.revision]))
  expect(await data(get('review/overview', [deck.id]))).toMatchObject({ due: 0, firstRecall: 0 })
  await data(post('review/start', [deck.id]))
  expect(await data(get('review/session', [deck.id]))).toBe(null)
})

test('rejects a rating for a changed reveal, then preserves the rating after archiving the deck', async () => {
  const round = await setupReview()
  const [deck] = (await data(get('backup/library', [null]))).decks
  const [entry] = (await data(get('library/deck', [deck.id, '', 'active', 0, 100]))).entries
  await data(post('library/update-entry', [deck.id, entry.id, { term: 'cache', meaning: '高速缓存' }, entry.revision]))
  const args = [round.sessionId, round.currentCardId, 'again', round.revision]
  expect((await post('review/score', args)).status).toBe(409)
  expect(await data(get('review/session', [deck.id]))).toMatchObject({ revealed: false, word: { prompt: '高速缓存' } })
  await data(post('review/reveal', [round.sessionId, round.currentCardId, entry.revision + 1, round.revision]))
  const scored = await data(post('review/score', [round.sessionId, round.currentCardId, 'again', round.revision + 1]))
  await data(post('library/archive-deck', [deck.id, true, deck.revision]))
  expect(await data(get('review/overview', [null]))).toMatchObject({ decks: [], due: 0, firstRecall: 0 })
  expect(await data(get('backup/library', [deck.id]))).toMatchObject({ reviewEvents: [scored.event] })
})

test('imports 1,665 unique words in file order and reads only the selected list', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Large book' }]))
  expect(await data(get('library/lists', [deck.id]))).toMatchObject({ listCount: 0, lists: [] })
  const terms = Array.from({ length: 1665 }, (_, index) => `term-${1665 - index}`)
  const source = [terms[0], ...terms, terms[5]].join('\n')
  const preview = await data(post('library/import-preview', [deck.id, source, 'txt', 'words', { term: 0 }]))
  expect(await data(post('library/import', [deck.id, preview.candidates, 'skip']))).toEqual({ added: 1665, updated: 0, skipped: 0 })
  const { lists } = await data(get('library/lists', [deck.id]))
  expect(lists).toHaveLength(56)
  expect(lists.map(({ count }: { count: number }) => count)).toEqual([...Array(55).fill(30), 15])
  expect(lists[0]).toMatchObject({ name: 'List 01', order: 1, learned: 0 })
  expect(lists[55]).toMatchObject({ name: 'List 56', order: 56, learned: 0 })
  for (const list of [lists[0], lists[1], lists[55]]) {
    const words = await data(get('library/list', [deck.id, list.id]))
    expect(words.map(({ term }: { term: string }) => term)).toEqual(terms.slice((list.order - 1) * 30, list.order * 30))
  }
  const appended = await data(post('library/create-entry', [deck.id, { term: 'extra' }]))
  const updated = await data(get('library/lists', [deck.id]))
  expect(updated.lists.slice(0, 55)).toEqual(lists.slice(0, 55))
  expect(updated.lists[55]).toMatchObject({ id: lists[55].id, count: 16 })
  expect((await data(get('library/list', [deck.id, lists[55].id]))).at(-1)).toEqual(appended)
})

test('keeps scoped practice, list completion, the daily limit and first recall independent', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Book', listSize: 2 }]))
  const preview = await data(post('library/import-preview', [deck.id, 'zebra\t斑马\nant\t蚂蚁\nbird\t鸟', 'txt', 'tab', { term: 0, meaning: 1 }]))
  await data(post('library/import', [deck.id, preview.candidates, 'skip']))
  const { lists: [first, second] } = await data(get('library/lists', [deck.id]))
  const [zebra, ant] = await data(get('library/list', [deck.id, first.id]))
  const [bird] = await data(get('library/list', [deck.id, second.id]))
  await data(post('settings/daily', [1]))
  expect((await data(get('learn/daily', [deck.id, first.id]))).candidates).toEqual([zebra])
  expect((await post('learn/start', [deck.id, 'copy', [bird.id], true, first.id])).status).toBe(409)
  const session = await data(post('learn/start', [deck.id, 'copy', [zebra.id], true, first.id]))
  expect(session).toMatchObject({ listId: first.id, entryIds: [zebra.id] })
  expect((await post('learn/start', [deck.id, 'copy', [bird.id], true, second.id])).status).toBe(409)
  await data(post('learn/attempt', [session.sessionId, zebra.id, zebra.term, session.revision]))
  await data(post('learn/finish', [session.sessionId, zebra.id, 'completed', session.revision + 1]))
  expect((await data(get('learn/daily', [deck.id, second.id]))).candidates).toEqual([])
  expect(await data(get('library/lists', [deck.id]))).toMatchObject({ completedLists: 0, lists: [{ learned: 1 }, { learned: 0 }] })
  expect((await data(get('review/overview', [deck.id]))).firstRecall).toBe(1)
  expect(count('practice_events')).toBe(1)

  now += 86_400_000
  const secondSession = await data(post('learn/start', [deck.id, 'copy', [bird.id], true, second.id]))
  await data(post('learn/attempt', [secondSession.sessionId, bird.id, bird.term, secondSession.revision]))
  await data(post('learn/finish', [secondSession.sessionId, bird.id, 'completed', secondSession.revision + 1]))
  await data(post('library/create-entry', [deck.id, { term: 'fox' }]))
  const overview = await data(get('library/lists', [deck.id]))
  expect(overview).toMatchObject({ completedLists: 1, lists: [
    { id: first.id, count: 2, learned: 1 }, { id: second.id, count: 1, learned: 1 }, { count: 1, learned: 0 },
  ] })
  expect((await data(get('library/list', [deck.id, first.id]))).map(({ id }: { id: string }) => id)).toEqual([zebra.id, ant.id])
})

test('migration backfills stable membership without rewriting word bodies, study histories or FSRS cards', async () => {
  const review = await setupReview()
  await data(post('review/score', [review.sessionId, review.currentCardId, 'good', review.revision]))
  const before = await data(get('backup/library', [null]))
  const { id } = before.decks[0]
  const entry = before.entries[0]
  const insert = db.prepare('INSERT INTO entries (id, deck_id, active_term, body, revision) VALUES (?, ?, ?, ?, ?)')
  const ids = [entry.id]
  for (let i = 0; i < 31; i++) {
    const id = randomUUID()
    const term = `legacy-${i}`
    ids.push(id)
    insert.run(id, entry.deckId, term, JSON.stringify({ ...entry, id, term, normalizedTerm: term }), entry.revision)
  }
  const legacy = await data(get('backup/library', [null]))
  db.exec(`DROP TABLE deck_list_members; DROP TABLE deck_lists; DROP INDEX entries_id_deck;
    ALTER TABLE owner_settings DROP COLUMN study_weekdays;
    ALTER TABLE owner_settings DROP COLUMN review_reset_minutes;
    DROP TABLE spelling_attempts; ALTER TABLE owner_settings DROP COLUMN spelling;
    PRAGMA user_version=9; CREATE TABLE deck_list_members (marker TEXT);`)
  expect(() => migrate(db)).toThrow('already exists')
  expect(db.pragma('user_version', { simple: true })).toBe(9)
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='deck_lists'").get()).toBeUndefined()
  db.exec('DROP TABLE deck_list_members')
  migrate(db)
  const upgraded = await data(get('backup/library', [null]))
  for (const key of ['decks', 'entries', 'learnProgress', 'practiceEvents', 'reviewCards', 'reviewEvents']) {
    expect(upgraded[key]).toEqual(legacy[key])
  }
  const { lists } = await data(get('library/lists', [id]))
  expect(lists.map(({ count }: { count: number }) => count)).toEqual([30, 2])
  expect((await data(get('library/list', [id, lists[0].id]))).map(({ id }: { id: string }) => id)).toEqual(ids.sort().slice(0, 30))
  migrate(db)
  expect(await data(get('library/lists', [id]))).toMatchObject({ lists })
})

test('keeps free spelling isolated while persisting bounded retry rounds and idempotent errors', async () => {
  const deck = await data(post('library/create-deck', [{ name: 'Practice' }]))
  const letter = await data(post('library/create-entry', [deck.id, { term: 'letter', meaning: '信' }]))
  const original = await data(post('learn/start', [deck.id, 'copy', [letter.id], true]))
  const prefs = await data(get('settings/spelling'))
  await data(post('settings/save-spelling', [{ ...prefs, retryLimit: 1, keyboard: 'simplified' }]))
  const list = (await data(get('library/lists', [deck.id]))).lists[0]
  let free = await data(post('learn/start-free', [deck.id, 'dictation', list.id]))
  const word = async () => data(get('learn/session', [free.sessionId]))
  expect(await word()).toMatchObject({ entry: { term: '' }, answerVisible: false, keyboard: { layout: 'full' } })
  await data(post('learn/hint', [free.sessionId, letter.id, 'keyboard', true, free.revision]))
  const guided = await word()
  free = guided.session
  expect(guided).toMatchObject({ entry: { term: '' }, answerVisible: false, keyboard: { layout: 'simplified' }, session: { currentAssisted: true } })
  const key = randomUUID()
  const wrong = [free.sessionId, letter.id, 'leter', free.revision]
  const first = await data(post('learn/attempt', wrong, key))
  expect(first).toMatchObject({ correct: false, assisted: true, attempts: 1 })
  expect(await data(post('learn/attempt', wrong, key))).toEqual(first)
  expect((await post('learn/attempt', wrong)).status).toBe(409)
  expect(count('spelling_attempts')).toBe(1)
  free = (await word()).session
  await data(post('learn/attempt', [free.sessionId, letter.id, 'letter', free.revision]))
  free = (await word()).session
  await data(post('learn/finish', [free.sessionId, letter.id, 'completed', free.revision]))
  const retry = await word()
  free = retry.session
  expect(free.entryIds).toEqual([letter.id, letter.id])
  expect(retry).toMatchObject({ keyboard: { layout: 'full' }, session: { currentIndex: 1, currentAssisted: false } })
  await data(post('learn/status', [free.sessionId, 'paused', free.revision]))
  free = await data(get('learn/free'))
  await data(post('learn/resume', [free.sessionId, free.revision]))
  free = (await word()).session
  await data(post('learn/attempt', [free.sessionId, letter.id, 'leyter', free.revision]))
  free = (await word()).session
  await data(post('learn/attempt', [free.sessionId, letter.id, 'letter', free.revision]))
  free = (await word()).session
  await data(post('learn/finish', [free.sessionId, letter.id, 'completed', free.revision]))
  const result = await data(get('learn/history', [free.sessionId, 0, 100]))
  expect(result).toMatchObject({ completed: 2, firstCompleted: 0, firstTryCorrect: 0, retried: 1,
    difficult: ['letter'], session: { status: 'completed', entryIds: [letter.id, letter.id] } })
  expect(await data(get('learn/session', [original.sessionId]))).toMatchObject({ session: original })
  expect(await data(get('learn/daily', [deck.id]))).toMatchObject({ completedToday: 0 })
  expect(count('learn_progress')).toBe(0)
  expect(count('review_events')).toBe(0)
  expect(count('review_cards')).toBe(0)
  const detail = await data(get('library/word-detail', [deck.id, letter.id]))
  expect(detail.spelling).toMatchObject({ attempts: 4, failures: 2, firstCorrect: 0,
    positions: [{ position: 2, expected: 't' }, { position: 3, expected: 't' }] })
  await data(post('library/update-entry', [deck.id, letter.id, { term: 'letters', meaning: '信件' }, letter.revision]))
  expect(await data(get('library/word-detail', [deck.id, letter.id]))).toMatchObject({
    spelling: { attempts: 4, currentAttempts: 0, positions: [] },
  })
})

test('free spelling and ending a free round leave an existing FSRS card, review event and LearnProgress byte-for-byte intact', async () => {
  const review = await setupReview()
  await data(post('review/score', [review.sessionId, review.currentCardId, 'good', review.revision]))
  const snapshot = () => ['review_events', 'review_cards', 'learn_progress']
    .map((table) => db.prepare(`SELECT body FROM ${table} ORDER BY body`).pluck().all())
  const before = snapshot()
  const deckId = db.prepare('SELECT id FROM decks').pluck().get()
  const entryId = db.prepare('SELECT id FROM entries').pluck().get()
  const free = await data(post('learn/start-free', [deckId, 'copy', null]))
  await data(post('learn/attempt', [free.sessionId, entryId, 'cache', free.revision]))
  const saved = (await data(get('learn/session', [free.sessionId]))).session
  await data(post('learn/finish', [free.sessionId, entryId, 'completed', saved.revision]))
  expect(snapshot()).toEqual(before)
  const next = await data(post('learn/start-free', [deckId, 'copy', null]))
  await data(post('learn/status', [next.sessionId, 'abandoned', next.revision]))
  expect(await data(get('learn/history', [next.sessionId, 0, 100]))).toMatchObject({
    session: { status: 'abandoned' }, completed: 0, unfinished: 1,
  })
  expect(snapshot()).toEqual(before)
})

test('starts scoped Review directly, resumes a revealed paused card and reports a different scope without changing it', async () => {
  const round = await setupReview()
  const other = await data(post('library/create-deck', [{ name: 'Another book' }]))
  await data(post('review/status', [round.sessionId, 'paused', round.revision]))
  const paused = await data(get('review/open'))

  expect(await data(post('review/start', [other.id, true]))).toEqual({ kind: 'conflict', session: paused })
  expect(await data(get('review/scoped', [other.id, round.sessionId]))).toBeNull()
  expect(await data(get('review/open'))).toEqual(paused)
  const resumed = await data(post('review/start', [round.deckId, true]))
  expect(resumed).toMatchObject({
    kind: 'round', round: { session: { sessionId: round.sessionId, currentCardId: round.currentCardId, status: 'active' },
      revealed: true, word: { answer: { term: 'cache' } } },
  })
  expect(count('review_events')).toBe(0)
  expect(await data(post('review/start', [round.deckId, true]))).toEqual(resumed)
})

test('All prioritizes FSRS reviews, recovers its handoff and counts first learning separately', async () => {
  const original = await setupReview()
  const deck = original.deckId
  await data(post('review/score', [original.sessionId, original.currentCardId, 'easy', original.revision]))
  async function seedWord(term: string, meaning: string, rating?: string) {
    const entry = await data(post('library/create-entry', [deck, { term, meaning }]))
    const session = await data(post('learn/start', [deck, 'copy', [entry.id], true]))
    await data(post('learn/attempt', [session.sessionId, entry.id, term, session.revision]))
    const current = await data(get('learn/session', [session.sessionId]))
    await data(post('learn/finish', [session.sessionId, entry.id, 'completed', current.session.revision]))
    if (rating) {
      const { round } = await data(post('review/start', [deck, true]))
      await data(post('review/reveal', [round.session.sessionId, round.session.currentCardId, entry.revision, round.session.revision]))
      const shown = await data(get('review/scoped', [deck, round.session.sessionId]))
      await data(post('review/score', [shown.session.sessionId, shown.session.currentCardId, rating, shown.session.revision]))
    }
  }
  await seedWord('mutex', '互斥锁', 'again')
  await seedWord('thread', '线程')
  const newWord = await data(post('library/create-entry', [deck, { term: 'buffer', meaning: '缓冲区' }]))
  const latestDue = db.prepare("SELECT max(json_extract(body, '$.dueAt')) FROM review_cards").pluck().get() as number
  now = latestDue + 1000
  expect(await data(get('review/overview', [deck]))).toMatchObject({ due: 2, firstRecall: 1 })
  expect(await data(get('learn/daily', [deck]))).toMatchObject({ pendingNew: 1 })

  const started = await data(post('learn/all', [deck, 'copy']))
  expect(started.kind).toBe('review')
  expect(await data(post('learn/all', [deck, 'copy']))).toEqual(started)
  for (const [prompt, card] of [['互斥锁', true], ['缓存', true], ['线程', false]]) {
    const { session, word } = await data(get('review/scoped', [deck, started.session.sessionId]))
    expect(word).toEqual({ prompt, card, entryRevision: 1 })
    await data(post('review/reveal', [session.sessionId, session.currentCardId, word.entryRevision, session.revision]))
    const shown = await data(get('review/scoped', [deck, session.sessionId]))
    await data(post('review/score', [session.sessionId, session.currentCardId, 'easy', shown.session.revision]))
  }

  // A second device has only the selected deck, not the flow URL.
  const next = await data(post('learn/all', [deck, 'copy']))
  expect(next).toMatchObject({ kind: 'learn', flowId: started.flowId, session: { entryIds: [newWord.id] } })
  expect(await data(post('learn/all', [deck, 'copy', started.flowId]))).toEqual(next)
  await data(post('learn/attempt', [next.session.sessionId, newWord.id, 'buffer', next.session.revision]))
  const learning = await data(get('learn/session', [next.session.sessionId]))
  await data(post('learn/finish', [next.session.sessionId, newWord.id, 'completed', learning.session.revision]))
  expect(await data(post('learn/all', [deck, 'copy', started.flowId]))).toEqual({
    kind: 'complete', flowId: started.flowId, reviewed: 3, learned: 1, pending: 1, ended: false,
  })
  expect(count('review_events')).toBe(5)
  expect(count('review_cards')).toBe(3)
})

test('All still reviews on a non-study day and can end without allocating new words', async () => {
  const round = await setupReview()
  await data(post('library/create-entry', [round.deckId, { term: 'buffer', meaning: '缓冲区' }]))
  await data(post('settings/timezone', ['UTC']))
  await data(post('settings/plan', [10, 2, 210]))
  now = Date.parse('2026-11-15T12:00:00Z') // Sunday
  expect(await data(get('learn/daily', [round.deckId]))).toMatchObject({ quota: 0, pendingNew: 0 })
  const started = await data(post('learn/all', [round.deckId, 'copy']))
  expect(started).toMatchObject({ kind: 'review', session: { sessionId: round.sessionId, currentRevealed: true } })
  await data(post('review/status', [started.session.sessionId, 'abandoned', started.session.revision]))
  expect(await data(post('learn/all', [round.deckId, 'copy', started.flowId]))).toMatchObject({
    kind: 'complete', reviewed: 0, learned: 0, pending: 1, ended: true,
  })
  expect(count('learn_sessions')).toBe(1)
  expect(count('review_events')).toBe(0)
})
