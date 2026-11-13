import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { prepareLibraryRestore } from '../../shared/backup/library.ts'
import type { LibraryExport } from '../../shared/contracts/library.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewEvent } from '../../shared/domain/review.ts'
import { meaningFromSenses } from '../../shared/domain/dictionary.ts'
import { createReviewScheduler, schedulerConfigSnapshot, schedulerGrades, serializeCard, serializeRevlog } from '../../shared/srs/scheduler.ts'
import { createApp } from '../app.ts'
import { initializeOwner, createAuth } from '../auth/owner.ts'
import { lockDataDirectory, openDatabase } from '../db/database.ts'
import { latestDatabaseVersion } from '../db/migrations/index.ts'
import { createLibraryService } from '../study/library.ts'
import { createStudyStore } from '../study/store.ts'
import { restoreLibrary } from './library.ts'
import { createSqliteBackup, restoreSqliteBackup, verifySqliteBackup } from './sqlite.ts'

async function fixture(): Promise<LibraryExport> {
  const date = new Date('2026-01-02T00:00:00.000Z')
  const now = date.getTime()
  const deckId = randomUUID(), entryId = randomUUID(), sessionId = randomUUID()
  const cardId = reviewCardId(entryId)
  const scheduler = await createReviewScheduler()
  const schedulerConfig = schedulerConfigSnapshot(scheduler)
  const rating = 'again'
  const rated = (time: Date) => scheduler.review({ card: scheduler.newCard({ now: time, cardId }), grade: schedulerGrades[rating], now: time })
  const raw = rated(date)
  const event: ReviewEvent = { id: randomUUID(), cardId, deckId, entryId, sessionId, direction: REVIEW_DIRECTION, rating,
    reviewedAt: now, schedulerModel: 'FSRS-7', schedulerConfigVersion: schedulerConfig.version,
    schedulerConfigSnapshot: schedulerConfig, resultingCardState: serializeCard(raw.card), schedulerRevlog: serializeRevlog(raw.revlog, rating) }
  const state = serializeCard(rated(date).card)
  return {
    format: 'lexyn-library', formatVersion: 4, exportedAt: date.toISOString(), metadata: { scope: 'library' },
    decks: [{ id: deckId, name: 'Archive', revision: 2, createdAt: now, updatedAt: now, archivedAt: now }],
    entries: [{ id: entryId, deckId, term: 'audit', meaning: '审计', meaningSource: 'ai', meaningNeedsReview: true,
      explanation: '系统化地检查记录。', pronunciationOverride: 'aw dit',
      normalizedTerm: 'audit', revision: 2, createdAt: now, updatedAt: now, deletedAt: now }],
    practiceEvents: [{ id: randomUUID(), deckId, entryId, sessionId, mode: 'copy', outcome: 'completed', attempts: 1,
      firstTryCorrect: true, assisted: false, startedAt: now, completedAt: now }],
    learnProgress: [{ entryId, firstCompletedAt: now, lastPracticedAt: now, completedCount: 1 }],
    settings: { dailyNewWords: 37, timezone: 'Asia/Shanghai' }, schedulerConfig, reviewEvents: [event],
    reviewCards: [{ id: cardId, entryId, deckId, direction: REVIEW_DIRECTION, revision: 1, lastEventId: event.id,
      createdAt: now, updatedAt: now, schedulerConfigVersion: schedulerConfig.version, schedulerState: state, dueAt: state.dueAt,
      scheduleStatus: state.scheduleStatus }],
  }
}

const parse = (value: unknown) => prepareLibraryRestore(JSON.stringify(value))

test('rejects corrupted or incomplete v4 JSON without accepting partial history', async () => {
  const good = await fixture()
  const result = await parse(good)
  expect(result.reviewChanges[0].event).toEqual(good.reviewEvents[0])
  expect(result.reviewChanges[0].card.schedulerState).toEqual(good.reviewCards[0].schedulerState)
  expect(result.reviewChanges[0].card.dueAt).toBeGreaterThan(good.reviewEvents[0].reviewedAt)
  expect((await parse({ ...good, entries: [{ ...good.entries[0], phoneticsCleared: true }] }))
    .backup.entries[0].phoneticsCleared).toBe(true)
  expect((await parse({ ...good, entries: [{ ...good.entries[0], phoneticsNeedsReview: true }] }))
    .backup.entries[0].phoneticsNeedsReview).toBe(true)
  await expect(parse({ ...good, entries: [{ ...good.entries[0], phoneticsNeedsReview: 'true' }] }))
    .rejects.toThrow('Invalid phonetics metadata')
  await expect(prepareLibraryRestore('{')).rejects.toThrow('not valid JSON')
  await expect(parse({ ...good, formatVersion: 2 })).rejects.toThrow('formats v4, v5, v6, v7 and v8')
  await expect(parse({ ...good, entries: [] })).rejects.toThrow('missing entry')
  await expect(parse({ ...good, reviewEvents: [] })).rejects.toThrow('incomplete')
  await expect(parse({ ...good, reviewEvents: [...good.reviewEvents, ...good.reviewEvents] })).rejects.toThrow('Duplicate ID')
  await expect(parse({ ...good, schedulerConfig: { ...good.schedulerConfig, version: 'other' } })).rejects.toThrow('Unsupported scheduler')
  const card = good.reviewCards[0]
  await expect(parse({ ...good, reviewCards: [{ ...card, schedulerState: { ...card.schedulerState, stabilityFast: 0 } }] }))
    .rejects.toThrow('does not match its FSRS history')
  const word = { ...good.entries[0], deletedAt: undefined }
  await expect(parse({ ...good, entries: [word, { ...word, id: randomUUID() }] })).rejects.toThrow('Duplicate active spelling')
})

test('rolls back JSON restore including library and history and retries into the still-empty instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexyn-import-test-'))
  const db = openDatabase(directory)
  try {
    await initializeOwner(db, 'test-admin', 'test-owner-password')
    const backup = await fixture()
    const dictionaryMeaning = { sourceWord: 'audit', sourceRevision: 'fixture', rawTranslation: 'n. 审计\\n[计] 审核',
      senses: [{ partOfSpeech: 'n.', definitions: ['审计'], source: 'ecdict' as const },
        { partOfSpeech: 'vt.', definitions: ['检查'], domain: '财务', source: 'manual' as const }] }
    backup.entries[0].dictionaryMeaning = dictionaryMeaning
    backup.entries[0].dictionaryReference = { sourceWord: 'audit', sourceRevision: 'fixture',
      translation: dictionaryMeaning.rawTranslation, definition: 'to examine records', partOfSpeech: 'n. vt.', phonetic: 'ˈɔːdɪt' }
    backup.entries[0].phonetics = { british: 'ˈɔːdɪt', american: 'ˈɑdɪt', unspecified: '/ˈɔːdɪt/' }
    backup.entries[0].phoneticsNeedsReview = true
    backup.entries[0].meaning = meaningFromSenses(dictionaryMeaning.senses)
    await expect(parse(backup)).rejects.toThrow('require backup format v5')
    backup.formatVersion = 5
    const plan = await parse(backup)
    const broken = { ...dictionaryMeaning, senses: [{ partOfSpeech: 'n.', definitions: ['x'.repeat(1001)], source: 'ai' }] }
    await expect(parse({ ...backup, entries: [{ ...backup.entries[0], dictionaryMeaning: broken }] })).rejects.toThrow('Invalid dictionary meaning')
    db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT, 'restore fault'); END")
    expect(() => restoreLibrary(db, plan)).toThrow('restore fault')
    for (const table of ['decks', 'entries', 'deck_lists', 'deck_list_members', 'practice_events', 'review_events', 'review_cards', 'learn_progress', 'owner_settings']) {
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0)
    }
    db.exec('DROP TRIGGER fail_restore')
    restoreLibrary(db, plan)
    expect(db.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(1)
    expect(db.prepare('SELECT position FROM deck_list_members WHERE entry_id=?').pluck().get(backup.entries[0].id)).toBe(1)
    expect(JSON.parse(db.prepare("SELECT json_extract(body, '$.dictionaryMeaning') FROM entries").pluck().get() as string))
      .toEqual(dictionaryMeaning)
    expect(JSON.parse(db.prepare("SELECT json_extract(body, '$.dictionaryReference') FROM entries").pluck().get() as string))
      .toEqual(backup.entries[0].dictionaryReference)
    expect(JSON.parse(db.prepare("SELECT json_extract(body, '$.phonetics') FROM entries").pluck().get() as string))
      .toEqual(backup.entries[0].phonetics)
    expect(db.prepare("SELECT json_extract(body, '$.phoneticsNeedsReview') FROM entries").pluck().get()).toBe(1)
    expect(db.prepare("SELECT json_extract(body, '$.pronunciationOverride') FROM entries").pluck().get()).toBe('aw dit')
    expect(db.prepare("SELECT json_extract(body, '$.explanation') FROM entries").pluck().get()).toBe('系统化地检查记录。')
    expect(db.prepare("SELECT json_extract(body, '$.meaningSource'), json_extract(body, '$.meaningNeedsReview') FROM entries").raw().get())
      .toEqual(['ai', 1])
    expect(() => restoreLibrary(db, plan)).toThrow('empty server')
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test('backs up WAL contents, rejects corruption and preserves an offline target rollback copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexyn-sqlite-test-'))
  const source = join(root, 'source'), target = join(root, 'target')
  const unlock = lockDataDirectory(source)
  const live = openDatabase(source)
  const password = 'test-owner-password'
  try {
    await initializeOwner(live, 'test-admin', password)
    restoreLibrary(live, await parse(await fixture()))
    const before = await createAuth(live).login('test-admin', password)
    if (before.status !== 'ok') throw new Error('Owner login failed.')
    const saved = await createSqliteBackup(source, join(root, 'backups'))
    expect(await verifySqliteBackup(saved.directory)).toMatchObject({ sha256: saved.sha256, bytes: saved.bytes, schemaVersion: latestDatabaseVersion })
    expect((await stat(join(saved.directory, 'lexyn.sqlite'))).mode & 0o777).toBe(0o600)
    await expect(restoreSqliteBackup(source, saved.directory)).rejects.toThrow('in use')
    const previous = openDatabase(target)
    await initializeOwner(previous, 'test-admin', 'different-owner-password')
    previous.close()
    const restored = await restoreSqliteBackup(target, saved.directory)
    expect(restored.rollback).toBeTruthy()
    expect((await stat(restored.rollback!)).isFile()).toBe(true)
    const db = openDatabase(target)
    try {
      const session = await createAuth(db).login('test-admin', password)
      if (session.status !== 'ok') throw new Error('Restored Owner could not log in.')
      const headers = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId, Cookie: `lexyn-session=${session.token}` }
      const app = createApp(db)
      const oldClient = await app.request('/api/settings/owner', { headers: { ...headers, Cookie: `lexyn-session=${before.token}` } })
      expect(oldClient.status).toBe(401)
      const fresh = await app.request('/api/settings/owner', { headers })
      expect(fresh.status).toBe(200)
      expect(await fresh.json()).toMatchObject({ data: { dailyNewWords: 37, timezone: 'Asia/Shanghai' } })
      expect(db.prepare('SELECT count(*) FROM review_cards').pluck().get()).toBe(1)
    } finally { db.close() }
    await appendFile(join(saved.directory, 'lexyn.sqlite'), 'corrupt')
    await expect(verifySqliteBackup(saved.directory)).rejects.toThrow('SHA-256')
    await expect(restoreSqliteBackup(target, saved.directory)).rejects.toThrow('SHA-256')
    const unchanged = openDatabase(target)
    try { expect(unchanged.prepare('SELECT count(*) FROM review_events').pluck().get()).toBe(1) }
    finally { unchanged.close() }
  } finally { live.close(); unlock(); await rm(root, { recursive: true, force: true }) }
})

test('validates v6 list ownership, coverage and positions and preserves list IDs in JSON restore', async () => {
  const legacy = await fixture()
  const list = { id: randomUUID(), deckId: legacy.decks[0].id, name: 'Audit chapter', order: 1 }
  const member = { listId: list.id, entryId: legacy.entries[0].id, position: 1 }
  const backup: LibraryExport = { ...legacy, formatVersion: 6, lists: [list], listMembers: [member] }
  await expect(parse({ ...backup, listMembers: [] })).rejects.toThrow('List membership is incomplete')
  await expect(parse({ ...backup, lists: [{ ...list, deckId: randomUUID() }] })).rejects.toThrow('Invalid deck list')
  await expect(parse({ ...backup, listMembers: [{ ...member, listId: randomUUID() }] })).rejects.toThrow('Invalid list membership')
  await expect(parse({ ...backup, listMembers: [{ ...member, position: 0 }] })).rejects.toThrow('Invalid list membership')
  const directory = await mkdtemp(join(tmpdir(), 'lexyn-lists-restore-'))
  const db = openDatabase(directory)
  try {
    await initializeOwner(db, 'test-admin', 'test-owner-password')
    restoreLibrary(db, await parse(backup))
    const ownerId = db.prepare('SELECT id FROM owner').pluck().get() as string
    const library = createLibraryService(createStudyStore(db, ownerId), backup.schedulerConfig)
    const snapshot = library.exportLibrary(list.deckId)
    expect(snapshot).toMatchObject({ formatVersion: 8, lists: [list], listMembers: [member], metadata: { scope: 'deck' } })
    expect(snapshot.reviewCards).toEqual(backup.reviewCards)
    expect(snapshot.entries).toMatchObject(backup.entries)
    expect(snapshot.entries[0].wordId).toBeTruthy()
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test('round-trips v7 spelling positions, free practice, and Owner preferences without changing FSRS', async () => {
  const legacy = await fixture()
  const entry = legacy.entries[0]
  const event = legacy.practiceEvents[0]
  const sessionId = randomUUID()
  const listId = randomUUID()
  const spelling = { keyboard: 'simplified', strict: true, retryLimit: 2, speakLetters: false, syllables: true } as const
  const backup: LibraryExport = {
    ...legacy, formatVersion: 7,
    lists: [{ id: listId, deckId: entry.deckId, name: 'List 01', order: 1 }],
    listMembers: [{ listId, entryId: entry.id, position: 1 }],
    settings: { ...legacy.settings, spelling },
    practiceEvents: [event,
      { ...event, id: randomUUID(), sessionId, source: 'free', round: 0, attempts: 2, firstTryCorrect: false },
      { ...event, id: randomUUID(), sessionId, source: 'free', round: 1 }],
    spellingAttempts: [{
      id: randomUUID(), entryId: entry.id, sessionId, round: 0, attempt: 1, spelling: entry.term,
      time: entry.createdAt, source: 'free', mode: 'copy', keyboard: 'simplified', correct: false, assisted: false,
      errors: [{ position: 1, type: 'incorrect', expected: 'u' }],
    }],
  }
  await expect(parse({ ...backup, spellingAttempts: [{ ...backup.spellingAttempts[0], errors: [
    { position: 1, expected: 'a', type: 'incorrect' },
  ] }] })).rejects.toThrow('Invalid spelling error')
  const directory = await mkdtemp(join(tmpdir(), 'lexyn-spelling-restore-'))
  const db = openDatabase(directory)
  try {
    await initializeOwner(db, 'test-admin', 'test-owner-password')
    restoreLibrary(db, await parse(backup))
    const ownerId = db.prepare('SELECT id FROM owner').pluck().get() as string
    const store = createStudyStore(db, ownerId)
    const restored = createLibraryService(store, backup.schedulerConfig).exportLibrary()
    expect(store.spellingSettings()).toEqual(spelling)
    expect(restored).toMatchObject({ spellingAttempts: backup.spellingAttempts, learnProgress: legacy.learnProgress,
      reviewEvents: legacy.reviewEvents, reviewCards: legacy.reviewCards })
    await expect(parse(restored)).resolves.toBeDefined()
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
