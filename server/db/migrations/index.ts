import { migrateGlobalWords } from './global-words.ts'
import type Database from 'better-sqlite3'
import { seedDeckLists } from '../../study/lists.ts'

const studySchema = `
  CREATE TABLE decks (
    id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL CHECK (json_valid(body)),
    revision INTEGER NOT NULL CHECK (revision > 0 AND json_extract(body, '$.revision') IS revision)
  ) STRICT;
  CREATE TABLE entries (
    id TEXT PRIMARY KEY NOT NULL, deck_id TEXT NOT NULL REFERENCES decks(id),
    active_term TEXT, body TEXT NOT NULL CHECK (json_valid(body)),
    revision INTEGER NOT NULL CHECK (revision > 0 AND json_extract(body, '$.revision') IS revision), UNIQUE (deck_id, active_term)
  ) STRICT;
  CREATE TABLE practice_events (
    id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id),
    body TEXT NOT NULL CHECK (json_valid(body))
  ) STRICT;
  CREATE INDEX practice_entry ON practice_events(entry_id);
  CREATE TABLE learn_progress (
    entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), body TEXT NOT NULL CHECK (json_valid(body))
  ) STRICT;
  CREATE TABLE review_events (
    id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), card_id TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL CHECK (reviewed_at >= 0), body TEXT NOT NULL CHECK (json_valid(body)),
    FOREIGN KEY (card_id) REFERENCES review_cards(id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE INDEX review_card_events ON review_events(card_id, reviewed_at, id);
  CREATE TABLE review_cards (
    id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id),
    direction TEXT NOT NULL CHECK (direction = 'meaning-to-term'), revision INTEGER NOT NULL CHECK (revision > 0 AND json_extract(body, '$.revision') IS revision),
    body TEXT NOT NULL CHECK (json_valid(body)), UNIQUE (entry_id, direction)
  ) STRICT;
  CREATE TABLE learn_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    deck_id TEXT NOT NULL REFERENCES decks(id),
    status TEXT NOT NULL CHECK (status IN ('active','paused','abandoned','completed')),
    revision INTEGER NOT NULL CHECK (revision > 0 AND json_extract(body, '$.revision') IS revision),
    body TEXT NOT NULL CHECK (json_valid(body))
  ) STRICT;
  CREATE UNIQUE INDEX learn_one_open ON learn_sessions ((1)) WHERE status IN ('active','paused');
  CREATE TABLE review_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    deck_id TEXT REFERENCES decks(id),
    status TEXT NOT NULL CHECK (status IN ('active','paused','abandoned','completed')),
    revision INTEGER NOT NULL CHECK (revision > 0 AND json_extract(body, '$.revision') IS revision),
    updated_at INTEGER NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body))
  ) STRICT;
  CREATE UNIQUE INDEX review_one_open ON review_sessions ((1)) WHERE status IN ('active','paused');
  CREATE INDEX review_recent ON review_sessions (deck_id, updated_at DESC);
  CREATE UNIQUE INDEX practice_session_entry ON practice_events (json_extract(body, '$.sessionId'), entry_id);
  CREATE UNIQUE INDEX review_session_card ON review_events (json_extract(body, '$.sessionId'), card_id);
  CREATE INDEX review_time ON review_events (reviewed_at);
`

function repairInterimStudySchema(db: Database.Database) {
  const columns = (db.pragma('table_info(review_events)') as { name: string }[]).map(({ name }) => name)
  if (columns.includes('reviewed_at') && !columns.includes('device_id')) return
  if (!columns.includes('effective_reviewed_at') || !columns.includes('device_id')) {
    throw new Error('The SQLite study schema is not recognized.')
  }

  // An interim development build advanced user_version while retaining the sync tables.
  // Recreate only empty business tables. Leave authentication and settings in place.
  const studyTables = [
    'review_events', 'review_cards', 'review_sessions', 'learn_sessions',
    'practice_events', 'learn_progress', 'entries', 'decks',
  ]
  for (const table of [...studyTables, 'sync_operations', 'sync_changes']) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error('The interim development database contains study data. Keep it and configure a new LEXYN_DATA_DIR.')
    }
  }
  for (const table of [...studyTables, 'sync_operations', 'sync_changes', 'sync_metadata', 'devices', 'app_meta']) {
    db.exec(`DROP TABLE ${table}`)
  }
  db.exec(studySchema)
}

// Version 3 starts the server-first schema. Versions 1 and 2 were development databases.
const migrations: ({ version: number; sql: string } | { version: number; apply: (db: Database.Database) => void })[] = [
  {
    version: 3,
    sql: `
      CREATE TABLE owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        failed_logins INTEGER NOT NULL DEFAULT 0, login_window INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES owner(id),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX session_expiry ON sessions(expires_at);
      ${studySchema}
      CREATE TABLE owner_settings (
        owner_id TEXT PRIMARY KEY NOT NULL REFERENCES owner(id),
        daily_new_words INTEGER NOT NULL CHECK (daily_new_words BETWEEN 1 AND 100),
        timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100)
      ) STRICT;
      CREATE TABLE request_idempotency (
        owner_id TEXT NOT NULL REFERENCES owner(id),
        id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response TEXT NOT NULL CHECK (json_valid(response)),
        PRIMARY KEY (owner_id, id)
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE owner ADD COLUMN username TEXT
        CHECK (length(username) BETWEEN 3 AND 32 AND username NOT GLOB '*[^a-z0-9._-]*'
          AND substr(username, 1, 1) GLOB '[a-z0-9]' AND substr(username, -1, 1) GLOB '[a-z0-9]');
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE owner RENAME COLUMN username TO previous_username;
      ALTER TABLE owner ADD COLUMN username TEXT
        CHECK (username IS NULL OR (length(username) BETWEEN 3 AND 32 AND username NOT GLOB '*[^a-z0-9._-]*'
          AND substr(username, 1, 1) GLOB '[a-z0-9]' AND substr(username, -1, 1) GLOB '[a-z0-9]'));
      UPDATE owner SET username = previous_username WHERE previous_username <> 'owner';
      ALTER TABLE owner DROP COLUMN previous_username;
      DELETE FROM sessions WHERE owner_id IN (SELECT id FROM owner WHERE username IS NULL);
    `,
  },
  { version: 6, apply: repairInterimStudySchema },
  {
    version: 7,
    sql: `
      CREATE TABLE speech_settings (
        owner_id TEXT PRIMARY KEY NOT NULL REFERENCES owner(id),
        voice_id TEXT NOT NULL,
        playback_rate REAL NOT NULL CHECK (playback_rate IN (0.8, 1, 1.2))
      ) STRICT;
      CREATE TABLE speech_assets (
        cache_key TEXT PRIMARY KEY NOT NULL CHECK (length(cache_key) = 64 AND cache_key NOT GLOB '*[^a-f0-9]*'),
        parameters TEXT NOT NULL CHECK (json_valid(parameters)),
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE speech_credentials (
        owner_id TEXT PRIMARY KEY NOT NULL REFERENCES owner(id),
        ciphertext TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE vocabulary_jobs (
        owner_id TEXT NOT NULL REFERENCES owner(id),
        deck_id TEXT NOT NULL REFERENCES decks(id),
        expires_at INTEGER NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        PRIMARY KEY (owner_id, deck_id)
      ) STRICT;
    `,
  },
  {
    version: 10,
    apply(db) {
      db.exec(`
        CREATE UNIQUE INDEX entries_id_deck ON entries(id, deck_id);
        CREATE TABLE deck_lists (
          id TEXT PRIMARY KEY NOT NULL, deck_id TEXT NOT NULL REFERENCES decks(id),
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
          list_order INTEGER NOT NULL CHECK (list_order > 0),
          UNIQUE (deck_id, list_order), UNIQUE (id, deck_id)
        ) STRICT;
        CREATE TABLE deck_list_members (
          entry_id TEXT PRIMARY KEY NOT NULL, list_id TEXT NOT NULL, deck_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position > 0), UNIQUE (list_id, position),
          FOREIGN KEY (entry_id, deck_id) REFERENCES entries(id, deck_id),
          FOREIGN KEY (list_id, deck_id) REFERENCES deck_lists(id, deck_id)
        ) STRICT;
      `)
      seedDeckLists(db)
    },
  },
  {
    version: 11,
    sql: `
      ALTER TABLE owner_settings ADD COLUMN study_weekdays INTEGER NOT NULL DEFAULT 127 CHECK (study_weekdays BETWEEN 1 AND 127);
      ALTER TABLE owner_settings ADD COLUMN review_reset_minutes INTEGER NOT NULL DEFAULT 0 CHECK (review_reset_minutes BETWEEN 0 AND 1439);
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE owner_settings ADD COLUMN spelling TEXT CHECK (spelling IS NULL OR json_valid(spelling));
      DROP INDEX learn_one_open;
      CREATE UNIQUE INDEX learn_one_open ON learn_sessions (coalesce(json_extract(body, '$.source'), 'learn'))
        WHERE status IN ('active','paused');
      DROP INDEX practice_session_entry;
      CREATE UNIQUE INDEX practice_session_entry ON practice_events
        (json_extract(body, '$.sessionId'), entry_id, coalesce(json_extract(body, '$.round'), 0));
      CREATE TABLE spelling_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        entry_id TEXT NOT NULL REFERENCES entries(id),
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 3),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        body TEXT NOT NULL CHECK (json_valid(body)),
        UNIQUE (session_id, entry_id, round, attempt)
      ) STRICT;
      CREATE INDEX spelling_attempt_entry ON spelling_attempts(entry_id);
    `,
  },
  { version: 13, apply: migrateGlobalWords },
]

export const latestDatabaseVersion = migrations.at(-1)!.version

export function migrate(db: Database.Database, target = latestDatabaseVersion) {
  db.transaction(() => {
    const currentVersion = db.pragma('user_version', { simple: true }) as number
    if (currentVersion === 1 || currentVersion === 2) {
      throw new Error('This development database uses the old architecture. Stop Lexyn and move the old data directory aside or configure a new LEXYN_DATA_DIR.')
    }
    const latestVersion = latestDatabaseVersion
    if (currentVersion > latestVersion) {
      throw new Error('The SQLite database schema is newer than this Lexyn build.')
    }

    for (const migration of migrations) {
      if (migration.version <= currentVersion || migration.version > target) continue
      if ('sql' in migration) db.exec(migration.sql)
      else migration.apply(db)
      db.pragma(`user_version = ${migration.version}`)
    }
  }).immediate()
}
