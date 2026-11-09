import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrations/index.ts'

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'lexyn.sqlite'))

  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
