import { createListStore } from './lists.ts'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { Deck, Entry } from '../../shared/domain/library.ts'
import type { LearnSession, PracticeEvent, LearnProgress } from '../../shared/domain/learning.ts'
import type { ReviewSession, ReviewCard, ReviewEvent } from '../../shared/domain/review.ts'
import { defaultSpelling, type PracticeSource, type SpellingAttempt, type SpellingPreferences } from '../../shared/domain/spelling.ts'
import { findWord, insertCardLink, saveWordProgress } from './words.ts'
import { wordKey, wordSlot, type Word, type WordCardLink, type WordProgress } from '../../shared/domain/word.ts'
import { allStudyDays } from '../../shared/domain/study-plan.ts'

export class StudyError extends Error {
  readonly status: 400 | 404 | 409

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

export type Versioned<T> = T & { revision: number }

export function checkRevision(record: { revision: number } | undefined, expected: number) {
  if (!record || record.revision !== expected) {
    throw new StudyError('This item changed on the server. Reload the latest version and try again.', 409)
  }
}

export function createStudyStore(db: Database.Database, ownerId: string) {
  function all<T>(sql: string, ...params: unknown[]): T[] {
    return (db.prepare(sql).all(...params) as { body: string }[]).map(({ body }) => JSON.parse(body) as T)
  }
  function one<T>(sql: string, ...params: unknown[]): T | undefined {
    const row = db.prepare(sql).get(...params) as { body: string } | undefined
    return row && JSON.parse(row.body) as T
  }

  let insertEntry: Database.Statement | undefined
  const prepareEntry = () => insertEntry ??= db.prepare(`INSERT INTO entries (id,deck_id,active_term,body,revision,word_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET active_term=excluded.active_term,body=excluded.body,revision=excluded.revision,word_id=excluded.word_id`)
  function entryWord(id: string) {
    const wordId = db.prepare('SELECT word_id FROM entries WHERE id=?').pluck().get(id) as string | undefined
    if (!wordId) throw new Error('An Entry is missing its Word.')
    return wordId
  }

  return {
    db,
    lists: createListStore(db),
    all,
    one,
    request<T>(id: string, payload: string, action: () => T): T {
      return db.transaction(() => {
        const fingerprint = createHash('sha256').update(payload).digest('hex')
        const receipt = db.prepare('SELECT fingerprint, response FROM request_idempotency WHERE owner_id=? AND id=?')
          .get(ownerId, id) as { fingerprint: string; response: string } | undefined
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new StudyError('Request ID has already been used for a different action.', 409)
          return JSON.parse(receipt.response) as T
        }
        const result = action()
        db.prepare('INSERT INTO request_idempotency VALUES (?, ?, ?, ?)')
          .run(ownerId, id, fingerprint, JSON.stringify(result ?? null))
        return result
      }).immediate()
    },
    settings() {
      const row = db.prepare(`SELECT daily_new_words AS dailyNewWords, timezone,
        study_weekdays AS studyWeekdays, review_reset_minutes AS reviewResetMinutes
        FROM owner_settings WHERE owner_id=?`).get(ownerId) as
          { dailyNewWords: number; timezone: string; studyWeekdays: number; reviewResetMinutes: number } | undefined
      return row ?? { dailyNewWords: 10, timezone: 'UTC', studyWeekdays: allStudyDays, reviewResetMinutes: 0 }
    },
    saveSettings(dailyNewWords: number, timezone: string, studyWeekdays = allStudyDays, reviewResetMinutes = 0) {
      db.prepare(`INSERT INTO owner_settings (owner_id, daily_new_words, timezone, study_weekdays, review_reset_minutes)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET daily_new_words=excluded.daily_new_words,
        timezone=excluded.timezone, study_weekdays=excluded.study_weekdays, review_reset_minutes=excluded.review_reset_minutes`)
        .run(ownerId, dailyNewWords, timezone, studyWeekdays, reviewResetMinutes)
    },
    spellingSettings(): SpellingPreferences {
      const raw = db.prepare('SELECT spelling FROM owner_settings WHERE owner_id=?').pluck().get(ownerId) as string | null | undefined
      return raw ? JSON.parse(raw) as SpellingPreferences : { ...defaultSpelling }
    },
    saveSpellingSettings(value: SpellingPreferences) {
      db.prepare(`INSERT INTO owner_settings (owner_id, daily_new_words, timezone, spelling) VALUES (?,10,'UTC',?)
        ON CONFLICT(owner_id) DO UPDATE SET spelling=excluded.spelling`).run(ownerId, JSON.stringify(value))
    },
    addSpellingAttempt(value: SpellingAttempt, wordId?: string) {
      db.prepare('INSERT INTO spelling_attempts (id,entry_id,session_id,round,attempt,body,word_id) VALUES (?,?,?,?,?,?,?)')
        .run(value.id, value.entryId, value.sessionId, value.round, value.attempt, JSON.stringify(value),
          wordId ?? entryWord(value.entryId))
    },
    decks: () => all<Deck>('SELECT body FROM decks'),
    deck: (id: string) => one<Deck>('SELECT body FROM decks WHERE id=?', id),
    entries: (deckId?: string) => deckId === undefined
      ? all<Entry>('SELECT body FROM entries')
      : all<Entry>('SELECT body FROM entries WHERE deck_id=?', deckId),
    entry: (id: string) => one<Entry>('SELECT body FROM entries WHERE id=?', id),
    activeEntry: (deckId: string, term: string) =>
      one<Entry>('SELECT body FROM entries WHERE deck_id=? AND active_term=?', deckId, wordSlot(term)),
    saveDeck(deck: Deck) {
      db.prepare(`INSERT INTO decks (id,body,revision) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision`)
        .run(deck.id, JSON.stringify(deck), deck.revision)
    },
    saveEntry(entry: Entry, restoredWordId?: string) {
      const prior = one<Word>('SELECT w.body FROM words w JOIN entries e ON e.word_id=w.id WHERE e.id=?', entry.id)
      const key = wordKey(entry.term, prior?.language)
      const wordId = restoredWordId ?? (prior && prior.normalizedTerm === key.normalizedTerm && prior.variant === key.variant
        ? prior.id : findWord(db, entry.term, entry.termChangedAt ?? entry.createdAt, key.language).id)
      const value = { ...entry, wordId }
      prepareEntry().run(value.id, value.deckId, value.deletedAt === undefined ? wordSlot(value.term) : null,
        JSON.stringify(value), value.revision, wordId)
      return value
    },
    entryWord,
    entriesForWord: (id: string) => all<Entry>('SELECT body FROM entries WHERE word_id=? AND active_term IS NOT NULL ORDER BY id', id),
    progress: () => all<WordProgress>('SELECT body FROM word_progress'),
    wordProgress: (id: string) => one<WordProgress>('SELECT body FROM word_progress WHERE word_id=?', id),
    entryProgress: (id: string) => one<WordProgress>(
      'SELECT p.body FROM word_progress p JOIN entries e ON p.word_id=e.word_id WHERE e.id=?', id),
    legacyProgress: (id: string) => one<LearnProgress>('SELECT body FROM learn_progress WHERE entry_id=?', id),
    saveWordProgress: (progress: WordProgress) => saveWordProgress(db, progress),
    saveProgress(progress: LearnProgress) {
      db.prepare('INSERT INTO learn_progress VALUES (?,?) ON CONFLICT(entry_id) DO UPDATE SET body=excluded.body')
        .run(progress.entryId, JSON.stringify(progress))
    },
    addPractice(event: PracticeEvent, wordId?: string) {
      db.prepare('INSERT INTO practice_events (id,entry_id,body,word_id) VALUES (?,?,?,?)')
        .run(event.id, event.entryId, JSON.stringify(event), wordId ?? entryWord(event.entryId))
    },
    addReview(event: ReviewEvent) {
      db.prepare('INSERT INTO review_events VALUES (?,?,?,?,?)')
        .run(event.id, event.entryId, event.cardId, event.reviewedAt, JSON.stringify(event))
    },
    saveCard(card: ReviewCard) {
      db.prepare('INSERT INTO review_cards VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body')
        .run(card.id, card.entryId, card.direction, card.revision, JSON.stringify(card))
    },
    linkCard: (link: WordCardLink) => insertCardLink(db, link),
    activeCards: () => all<ReviewCard & { wordId: string }>(
      "SELECT json_set(c.body, '$.wordId', w.word_id) AS body FROM review_cards c JOIN word_cards w ON c.id=w.card_id WHERE w.active=1"),
    activeCard: (wordId: string) => one<ReviewCard>(
      'SELECT c.body FROM review_cards c JOIN word_cards w ON c.id=w.card_id WHERE w.word_id=? AND w.active=1', wordId),
    card: (id: string) => one<ReviewCard>('SELECT body FROM review_cards WHERE id=?', id),
    cards: () => all<ReviewCard>('SELECT body FROM review_cards'),
    learn: (id: string) => one<Versioned<LearnSession>>('SELECT body FROM learn_sessions WHERE id=?', id),
    review: (id: string) => one<Versioned<ReviewSession>>('SELECT body FROM review_sessions WHERE id=?', id),
    openLearn: (source: PracticeSource = 'learn') => one<Versioned<LearnSession>>(
      "SELECT body FROM learn_sessions WHERE status IN ('active','paused') AND coalesce(json_extract(body, '$.source'), 'learn')=?", source),
    openReview: () => one<Versioned<ReviewSession>>("SELECT body FROM review_sessions WHERE status IN ('active','paused')"),
    saveLearn(session: LearnSession & { revision?: number }) {
      const updated = { ...session, revision: (session.revision ?? 0) + 1 }
      db.prepare(`INSERT INTO learn_sessions VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,body=excluded.body`)
        .run(updated.sessionId, updated.deckId, updated.status, updated.revision, JSON.stringify(updated))
      return updated
    },
    saveReview(session: ReviewSession & { revision?: number }) {
      const updated = { ...session, revision: (session.revision ?? 0) + 1 }
      db.prepare(`INSERT INTO review_sessions VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,
        updated_at=excluded.updated_at,body=excluded.body`)
        .run(updated.sessionId, updated.deckId ?? null, updated.status, updated.revision, updated.updatedAt, JSON.stringify(updated))
      return updated
    },
  }
}

export type StudyStore = ReturnType<typeof createStudyStore>
