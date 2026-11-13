import type Database from 'better-sqlite3'
import type { Entry } from '../../../shared/domain/library.ts'
import type { LearnSession } from '../../../shared/domain/learning.ts'
import { wordReviewCardId, type ReviewSession } from '../../../shared/domain/review.ts'
import { backfillWordHistory, bodyRows, findWord } from '../../study/words.ts'

export function migrateGlobalWords(db: Database.Database) {
  db.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY NOT NULL, language TEXT NOT NULL, normalized_term TEXT NOT NULL, variant TEXT NOT NULL,
      body TEXT NOT NULL CHECK (json_valid(body)), UNIQUE(language, normalized_term, variant)
    ) STRICT;
    CREATE TABLE word_progress (
      word_id TEXT PRIMARY KEY NOT NULL REFERENCES words(id), body TEXT NOT NULL CHECK(json_valid(body))
    ) STRICT;
    ALTER TABLE entries ADD COLUMN word_id TEXT REFERENCES words(id);
    ALTER TABLE practice_events ADD COLUMN word_id TEXT REFERENCES words(id);
    ALTER TABLE spelling_attempts ADD COLUMN word_id TEXT REFERENCES words(id);
    CREATE INDEX entries_word ON entries(word_id, deck_id);
    CREATE INDEX practice_word ON practice_events(word_id);
    CREATE INDEX spelling_attempt_word ON spelling_attempts(word_id);
    CREATE UNIQUE INDEX active_entry_word ON entries(deck_id, word_id) WHERE active_term IS NOT NULL;

    -- The old UNIQUE(entry_id, direction) prevents the same member from being renamed
    -- and then creating a card for its new Word. Copy both tables without changing any row.
    CREATE TABLE migrated_review_cards (
      id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id),
      direction TEXT NOT NULL CHECK (direction = 'meaning-to-term'),
      revision INTEGER NOT NULL CHECK (revision > 0 AND json_extract(body, '$.revision') IS revision),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE migrated_review_events (
      id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id),
      card_id TEXT NOT NULL REFERENCES migrated_review_cards(id) DEFERRABLE INITIALLY DEFERRED,
      reviewed_at INTEGER NOT NULL CHECK (reviewed_at >= 0), body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    INSERT INTO migrated_review_cards SELECT * FROM review_cards;
    INSERT INTO migrated_review_events SELECT * FROM review_events;
    DROP TABLE review_events;
    DROP TABLE review_cards;
    ALTER TABLE migrated_review_cards RENAME TO review_cards;
    ALTER TABLE migrated_review_events RENAME TO review_events;
    CREATE INDEX review_card_events ON review_events(card_id, reviewed_at, id);
    CREATE INDEX review_time ON review_events(reviewed_at);
    CREATE UNIQUE INDEX review_session_card ON review_events (json_extract(body, '$.sessionId'), card_id);
    CREATE TABLE word_cards (
      card_id TEXT PRIMARY KEY NOT NULL REFERENCES review_cards(id), word_id TEXT NOT NULL REFERENCES words(id),
      direction TEXT NOT NULL CHECK(direction = 'meaning-to-term'), active INTEGER NOT NULL CHECK(active IN (0,1))
    ) STRICT;
    CREATE INDEX word_card_history ON word_cards(word_id);
    CREATE UNIQUE INDEX word_active_card ON word_cards(word_id, direction) WHERE active=1;
  `)
  const entries = new Map<string, Entry>()
  const update = db.prepare('UPDATE entries SET word_id=?, body=? WHERE id=?')
  for (const entry of bodyRows<Entry>(db, "SELECT body FROM entries ORDER BY json_extract(body, '$.createdAt'), id")) {
    const wordId = findWord(db, entry.term, entry.createdAt).id
    const linked = { ...entry, wordId }
    entries.set(entry.id, linked)
    update.run(wordId, JSON.stringify(linked), entry.id)
  }
  backfillWordHistory(db)

  function sessionWord(id: string, startedAt: number) {
    const entry = entries.get(id)
    if (!entry || entry.termChangedAt !== undefined && entry.termChangedAt >= startedAt) return null
    return entry.wordId!
  }
  for (const session of bodyRows<LearnSession & { revision: number }>(db,
    "SELECT body FROM learn_sessions WHERE status IN ('active','paused')")) {
    const entryWords = Object.fromEntries(session.entryIds.map((id) => [id, sessionWord(id, session.startedAt)]))
    const revision = session.revision + 1
    db.prepare('UPDATE learn_sessions SET body=?, revision=? WHERE id=?')
      .run(JSON.stringify({ ...session, entryWords, revision }), revision, session.sessionId)
  }
  for (const session of bodyRows<ReviewSession & { revision: number }>(db,
    "SELECT body FROM review_sessions WHERE status IN ('active','paused')")) {
    const wordIds = session.entryIds.map((id) => sessionWord(id, session.startedAt))
    const wordId = wordIds[session.currentIndex]
    const active = wordId && db.prepare('SELECT card_id FROM word_cards WHERE word_id=? AND active=1')
      .pluck().get(wordId) as string | undefined
    const revision = session.revision + 1
    db.prepare('UPDATE review_sessions SET body=?, revision=? WHERE id=?')
      .run(JSON.stringify({ ...session, wordIds, currentCardId: wordId ? active || wordReviewCardId(wordId) : undefined,
        currentRevealed: !!wordId && session.currentRevealed, revision }), revision, session.sessionId)
  }
  for (const table of ['entries', 'practice_events', 'spelling_attempts']) {
    for (const event of ['INSERT', 'UPDATE'] as const) {
      db.exec(`CREATE TRIGGER ${table}_word_${event.toLowerCase()} BEFORE ${event} ON ${table}
        WHEN NEW.word_id IS NULL ${table === 'entries' ? "OR json_extract(NEW.body, '$.wordId') IS NOT NEW.word_id" : ''} BEGIN SELECT RAISE(ABORT, 'Missing global Word'); END`)
    }
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length || db.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('Global Word migration failed its SQLite reference or integrity check.')
  }
}
