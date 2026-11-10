import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { createAuth, initializeOwner } from '../auth/owner.ts'
import { createStudyStore } from '../study/store.ts'
import { openDatabase } from './database.ts'
import { migrate, latestDatabaseVersion } from './migrations/index.ts'

test('schema initialization is repeatable and commits data, authentication and receipts across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexyn-db-'))
  try {
    const db = openDatabase(directory)
    const password = 'test-restart-password'
    const deck = { id: randomUUID(), name: 'Persisted', revision: 1, createdAt: 1, updatedAt: 1 }
    const request = randomUUID()
    let login
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      await initializeOwner(db, 'test-admin', password)
      login = await createAuth(db).login('test-admin', password)
      if (login.status !== 'ok') throw new Error('Test login failed.')
      const store = createStudyStore(db, login.ownerId)
      store.request(request, 'create deck', () => { store.saveDeck(deck); return deck })
      migrate(db)
      expect(db.pragma('user_version', { simple: true })).toBe(latestDatabaseVersion)
    } finally { db.close() }
    const reopened = openDatabase(directory)
    try {
      expect(createAuth(reopened).session(login.token)?.ownerId).toBe(login.ownerId)
      const store = createStudyStore(reopened, login.ownerId)
      expect(store.decks()).toEqual([deck])
      expect(store.request(request, 'create deck', () => { throw new Error('Already committed') })).toEqual(deck)
    } finally { reopened.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test.each([1, 2, latestDatabaseVersion + 1])('refuses an unsupported database version %d without deleting its data', (version) => {
  const directory = mkdtempSync(join(tmpdir(), 'lexyn-unsupported-db-'))
  const path = join(directory, 'lexyn.sqlite')
  try {
    const old = new Database(path)
    old.exec(`PRAGMA user_version=${version}; CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('kept');`)
    old.close()
    expect(() => openDatabase(directory)).toThrow(version > latestDatabaseVersion ? 'newer' : 'old architecture')
    const reopened = new Database(path)
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(version)
      expect(reopened.prepare('SELECT value FROM marker').pluck().get()).toBe('kept')
    } finally { reopened.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

async function interimDatabase() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const password = randomUUID()
  await initializeOwner(db, 'dev-admin', password)
  const auth = createAuth(db)
  const login = await auth.login('dev-admin', password)
  if (login.status !== 'ok') throw new Error('Test login failed.')
  createStudyStore(db, login.ownerId).saveSettings(24, 'Asia/Shanghai')
  db.exec(`
    DROP TABLE vocabulary_jobs;
    DROP TABLE speech_credentials;
    DROP TABLE speech_settings;
    DROP TABLE speech_assets;
    DROP TABLE review_events;
    DROP TABLE practice_events;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY);
    CREATE TABLE sync_operations (device_id TEXT REFERENCES devices(id));
    CREATE TABLE sync_changes (id INTEGER PRIMARY KEY);
    CREATE TABLE sync_metadata (key TEXT PRIMARY KEY);
    CREATE TABLE review_events (
      id TEXT PRIMARY KEY, entry_id TEXT REFERENCES entries(id), card_id TEXT,
      device_id TEXT NOT NULL REFERENCES devices(id), effective_reviewed_at INTEGER NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE practice_events (
      id TEXT PRIMARY KEY, entry_id TEXT REFERENCES entries(id), device_id TEXT NOT NULL REFERENCES devices(id), body TEXT NOT NULL
    );
    ALTER TABLE decks ADD COLUMN device_id TEXT REFERENCES devices(id);
    ALTER TABLE entries ADD COLUMN device_id TEXT REFERENCES devices(id);
    PRAGMA user_version = 5;
  `)
  return { db, login }
}

test('repairs the empty interim schema and keeps the account, session and settings', async () => {
  const { db, login } = await interimDatabase()
  try {
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(latestDatabaseVersion)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='devices'").get()).toBeUndefined()
    expect(createAuth(db).session(login.token)?.ownerId).toBe(login.ownerId)
    expect(createStudyStore(db, login.ownerId).settings()).toEqual({ dailyNewWords: 24, timezone: 'Asia/Shanghai' })

    const { createApp } = await import('../app.ts')
    const app = createApp(db)
    const headers = { 'X-Lexyn-Client': '1', 'X-Lexyn-Owner': login.ownerId, Cookie: `lexyn-session=${login.token}` }
    for (const path of ['/api/review/overview?args=%5Bnull%5D', '/api/progress/overview']) {
      const response = await app.request(path, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: { ratedToday: 0, learnedToday: 0, due: 0 } })
    }
    const store = createStudyStore(db, login.ownerId)
    const now = Date.now()
    store.saveDeck({ id: randomUUID(), name: 'First deck', createdAt: now, updatedAt: now, revision: 1 })
    expect(store.decks()).toHaveLength(1)
  } finally { db.close() }
})

test('leaves a nonempty interim database intact', async () => {
  const { db, login } = await interimDatabase()
  try {
    const store = createStudyStore(db, login.ownerId)
    const deck = { id: randomUUID(), name: 'Existing deck', createdAt: 1, updatedAt: 1, revision: 1 }
    store.saveDeck(deck)
    expect(() => migrate(db)).toThrow('contains study data')
    expect(db.pragma('user_version', { simple: true })).toBe(5)
    expect(store.decks()).toEqual([deck])
    expect(createAuth(db).session(login.token)?.ownerId).toBe(login.ownerId)
  } finally { db.close() }
})
