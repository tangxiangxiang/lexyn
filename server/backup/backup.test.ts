import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { prepareLibraryRestore } from '../../shared/backup/library.ts'
import type { LibraryExport } from '../../shared/contracts/library.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewEvent } from '../../shared/domain/review.ts'
import { createReviewScheduler, schedulerConfigSnapshot, schedulerGrades, serializeCard, serializeRevlog } from '../../shared/srs/scheduler.ts'
import { createApp } from '../app.ts'
import { initializeOwner, createAuth } from '../auth/owner.ts'
import { lockDataDirectory, openDatabase } from '../db/database.ts'
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
  const rawTime = new Date(now + 86_400_000)
  const raw = rated(rawTime)
  const event: ReviewEvent = { id: randomUUID(), cardId, deckId, entryId, sessionId, direction: REVIEW_DIRECTION, rating,
    reviewedAt: rawTime.getTime(), effectiveReviewedAt: now, schedulerModel: 'FSRS-7', schedulerConfigVersion: schedulerConfig.version,
    schedulerConfigSnapshot: schedulerConfig, resultingCardState: serializeCard(raw.card), schedulerRevlog: serializeRevlog(raw.revlog, rating) }
  const state = serializeCard(rated(date).card)
  return {
    format: 'lexyn-library', formatVersion: 3, exportedAt: date.toISOString(), metadata: { scope: 'library', librarySchemaVersion: 4 },
    decks: [{ id: deckId, name: 'Archive', revision: 2, createdAt: now, updatedAt: now, archivedAt: now }],
    entries: [{ id: entryId, deckId, term: 'audit', meaning: '审计', normalizedTerm: 'audit', revision: 2, createdAt: now, updatedAt: now, deletedAt: now }],
    practiceEvents: [{ id: randomUUID(), deckId, entryId, sessionId, mode: 'copy', outcome: 'completed', attempts: 1,
      firstTryCorrect: true, assisted: false, startedAt: now, completedAt: now }],
    learnProgress: [{ entryId, firstCompletedAt: now, lastPracticedAt: now, completedCount: 1 }],
    dailyNewWords: 37, schedulerConfig, reviewEvents: [event],
    reviewCards: [{ id: cardId, entryId, deckId, direction: REVIEW_DIRECTION, revision: 1, lastEventId: event.id,
      createdAt: now, updatedAt: now, schedulerConfigVersion: schedulerConfig.version, schedulerState: state, dueAt: state.dueAt,
      scheduleStatus: state.scheduleStatus }],
  }
}

const parse = (value: unknown) => prepareLibraryRestore(JSON.stringify(value))

test('rejects corrupted or incomplete v3 JSON without accepting partial history', async () => {
  const good = await fixture()
  const result = await parse(good)
  expect(result.reviewChanges[0].event).toEqual(good.reviewEvents[0])
  expect(result.reviewChanges[0].card.schedulerState).toEqual(good.reviewCards[0].schedulerState)
  expect(result.reviewChanges[0].card.dueAt).toBeLessThan(good.reviewEvents[0].reviewedAt)
  await expect(prepareLibraryRestore('{')).rejects.toThrow('not valid JSON')
  await expect(parse({ ...good, formatVersion: 2 })).rejects.toThrow('format v3')
  await expect(parse({ ...good, entries: [] })).rejects.toThrow('missing entry')
  await expect(parse({ ...good, reviewEvents: [] })).rejects.toThrow('incomplete')
  await expect(parse({ ...good, reviewEvents: [...good.reviewEvents, ...good.reviewEvents] })).rejects.toThrow('Duplicate ID')
  await expect(parse({ ...good, schedulerConfig: { ...good.schedulerConfig, version: 'other' } })).rejects.toThrow('Unsupported scheduler')
  await expect(parse({ ...good, reviewCards: [{ ...good.reviewCards[0], schedulerState: good.reviewEvents[0].resultingCardState,
    dueAt: good.reviewEvents[0].resultingCardState.dueAt }] })).rejects.toThrow('does not match its FSRS history')
  const word = { ...good.entries[0], deletedAt: undefined }
  await expect(parse({ ...good, entries: [word, { ...word, id: randomUUID() }] })).rejects.toThrow('Duplicate active spelling')
})

test('rolls back JSON restore including the sync log and retries into the still-empty instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexyn-import-test-'))
  const db = openDatabase(directory)
  try {
    await initializeOwner(db, 'test-owner-password')
    const plan = await parse(await fixture())
    db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT, 'restore fault'); END")
    expect(() => restoreLibrary(db, plan)).toThrow('restore fault')
    for (const table of ['decks', 'entries', 'practice_events', 'review_events', 'review_cards', 'sync_changes', 'devices']) {
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0)
    }
    db.exec('DROP TRIGGER fail_restore')
    restoreLibrary(db, plan)
    expect(db.prepare('SELECT count(*) FROM sync_changes').pluck().get()).toBe(4)
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
    await initializeOwner(live, password)
    restoreLibrary(live, await parse(await fixture()))
    const saved = await createSqliteBackup(source, join(root, 'backups'))
    expect(await verifySqliteBackup(saved.directory)).toMatchObject({ sha256: saved.sha256, bytes: saved.bytes, schemaVersion: 2 })
    expect((await stat(join(saved.directory, 'lexyn.sqlite'))).mode & 0o777).toBe(0o600)
    await expect(restoreSqliteBackup(source, saved.directory)).rejects.toThrow('in use')
    const previous = openDatabase(target)
    previous.prepare("INSERT INTO app_meta VALUES ('rollback-marker', 'present')").run()
    previous.close()
    const restored = await restoreSqliteBackup(target, saved.directory)
    expect(restored.rollback).toBeTruthy()
    expect((await stat(restored.rollback!)).isFile()).toBe(true)
    const db = openDatabase(target)
    try {
      const session = await createAuth(db).login(password)
      if (session.status !== 'ok') throw new Error('Restored Owner could not log in.')
      const headers = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': session.ownerId, Cookie: `lexyn-session=${session.token}` }
      const app = createApp(db)
      const oldClient = await app.request('/api/sync/pull?after=0', { headers })
      expect(oldClient.status).toBe(409)
      expect(await oldClient.json()).toMatchObject({ error: { code: 'GENERATION' } })
      const fresh = await app.request('/api/bootstrap', { headers: { ...headers, 'X-Lexyn-Generation': restored.generation } })
      expect(fresh.status).toBe(200)
      expect(await fresh.json()).toMatchObject({ generation: restored.generation, serverSeq: 4, restoredDailyNewWords: 37 })
      expect(db.prepare('SELECT count(*) FROM review_cards').pluck().get()).toBe(1)
    } finally { db.close() }
    await appendFile(join(saved.directory, 'lexyn.sqlite'), 'corrupt')
    await expect(verifySqliteBackup(saved.directory)).rejects.toThrow('SHA-256')
    await expect(restoreSqliteBackup(target, saved.directory)).rejects.toThrow('SHA-256')
    const unchanged = openDatabase(target)
    try { expect(unchanged.prepare('SELECT count(*) FROM sync_changes').pluck().get()).toBe(4) }
    finally { unchanged.close() }
  } finally { live.close(); unlock(); await rm(root, { recursive: true, force: true }) }
})
