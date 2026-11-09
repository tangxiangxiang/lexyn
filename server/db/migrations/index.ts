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
  {
    version: 2,
    sql: `
      CREATE TABLE owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        failed_logins INTEGER NOT NULL DEFAULT 0, login_window INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX session_expiry ON sessions(expires_at);
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
        last_seen_at INTEGER NOT NULL, pull_cursor INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE decks (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        device_id TEXT NOT NULL REFERENCES devices(id), local_revision INTEGER NOT NULL, base_revision INTEGER
      ) STRICT;
      CREATE TABLE entries (
        id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES decks(id),
        active_term TEXT, body TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        device_id TEXT NOT NULL REFERENCES devices(id), local_revision INTEGER NOT NULL, base_revision INTEGER,
        UNIQUE (deck_id, active_term)
      ) STRICT;
      CREATE TABLE practice_events (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id),
        device_id TEXT NOT NULL REFERENCES devices(id), body TEXT NOT NULL
      ) STRICT;
      CREATE INDEX practice_entry ON practice_events(entry_id);
      CREATE TABLE learn_progress (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id), body TEXT NOT NULL
      ) STRICT;
      CREATE TABLE review_events (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), card_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(id), effective_reviewed_at INTEGER NOT NULL, body TEXT NOT NULL
      ) STRICT;
      CREATE INDEX review_card_events ON review_events(card_id, effective_reviewed_at, id);
      CREATE TABLE review_cards (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id),
        direction TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        body TEXT NOT NULL, UNIQUE (entry_id, direction)
      ) STRICT;
      CREATE TABLE sync_operations (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
        request_hash TEXT NOT NULL, server_seq INTEGER, applied INTEGER NOT NULL CHECK (applied IN (0, 1))
      ) STRICT;
      CREATE TABLE sync_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sync_metadata (
        key TEXT PRIMARY KEY, value INTEGER NOT NULL
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
