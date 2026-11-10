import type Database from 'better-sqlite3'

export function serverGeneration(db: Database.Database) {
  return db.prepare("SELECT value FROM app_meta WHERE key = 'sync_generation'").pluck().get() as string | undefined
}
