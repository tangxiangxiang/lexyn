import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrations/index.ts'

/** Hold a separate SQLite file lock across process crashes and database replacement. */
export function lockDataDirectory(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const lock = new Database(join(dataDir, 'lexyn-maintenance.sqlite'), { timeout: 0 })
  try {
    lock.exec('BEGIN IMMEDIATE')
    return () => lock.close()
  } catch (error) {
    lock.close()
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new Error('This data directory is in use. Stop Lexyn and any running restore first.')
    }
    throw error
  }
}

export function openDatabase(dataDir: string, schemaVersion?: number) {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'lexyn.sqlite'))

  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db, schemaVersion)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
