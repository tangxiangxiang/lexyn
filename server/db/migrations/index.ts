import type Database from 'better-sqlite3'

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
    `,
  },
]

export function migrate(db: Database.Database) {
  db.transaction(() => {
    const currentVersion = db.pragma('user_version', { simple: true }) as number
    const latestVersion = migrations.at(-1)!.version
    if (currentVersion > latestVersion) {
      throw new Error('The SQLite database schema is newer than this Lexyn build.')
    }

    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
    }
  }).immediate()
}
