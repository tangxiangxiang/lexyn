import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
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
      expect(db.pragma('user_version', { simple: true })).toBe(1)
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
