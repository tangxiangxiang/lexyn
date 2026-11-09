import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createAuth, initializeOwner } from '../auth/owner.ts'
import { createSyncRepository } from '../sync/repository.ts'
import { openDatabase } from './database.ts'
import { migrate } from './migrations/index.ts'

test('applies migrations once and preserves data after reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexyn-db-'))
  try {
    const db = openDatabase(directory)
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('test', 'saved')
      migrate(db)
      expect(db.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      db.close()
    }

    const reopened = openDatabase(directory)
    try {
      expect(reopened.prepare('SELECT value FROM app_meta WHERE key = ?').get('test')).toEqual({
        value: 'saved',
      })
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('persists Owner sessions, a synchronized deck and its receipt across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexyn-db-'))
  try {
    const db = openDatabase(directory)
    const now = Date.now()
    const id = randomUUID()
    const deviceId = randomUUID()
    const operation = {
      kind: 'deck.create' as const, payload: { id, name: 'Persisted', revision: 1, createdAt: now, updatedAt: now },
      opId: randomUUID(), entityId: id, schemaVersion: 1 as const, sequence: 1, baseRevision: 0, createdAt: now,
    }
    let login
    try {
      const password = 'test-restart-password'
      await initializeOwner(db, password)
      login = await createAuth(db).login(password)
      if (login.status !== 'ok') throw new Error('Test login failed.')
      const sync = createSyncRepository(db)
      sync.registerDevice(deviceId, login.ownerId, 0)
      expect(await sync.push(operation, deviceId)).toMatchObject({ status: 'accepted', serverSeq: 1 })
    } finally { db.close() }
    const reopened = openDatabase(directory)
    try {
      const session = createAuth(reopened).session(login.token)
      expect(session?.ownerId).toBe(login.ownerId)
      const sync = createSyncRepository(reopened)
      expect(await sync.push(operation, deviceId)).toMatchObject({ status: 'already_applied', serverSeq: 1 })
      expect(sync.page(login.ownerId, 0, 100)).toMatchObject({
        nextCursor: 1, changes: [{ seq: 1, record: { kind: 'deck', value: operation.payload } }],
      })
    } finally { reopened.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
