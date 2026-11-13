import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { recordWordCompletion, wordKey, type Word, type WordCardLink, type WordProgress } from '../../shared/domain/word.ts'
import type { Entry } from '../../shared/domain/library.ts'
import type { PracticeEvent } from '../../shared/domain/learning.ts'
import { REVIEW_DIRECTION, type ReviewCard, type ReviewEvent } from '../../shared/domain/review.ts'
import { sameReviewState } from '../../shared/backup/library.ts'
import type { SpellingAttempt } from '../../shared/domain/spelling.ts'

export function bodyRows<T>(db: Database.Database, sql: string, ...params: unknown[]): T[] {
  return (db.prepare(sql).pluck().all(...params) as string[]).map((body) => JSON.parse(body) as T)
}

export function insertWord(db: Database.Database, word: Word) {
  db.prepare('INSERT INTO words VALUES (?, ?, ?, ?, ?)').run(word.id, word.language, word.normalizedTerm, word.variant, JSON.stringify(word))
}

export function findWord(db: Database.Database, term: string, createdAt: number, language = 'en') {
  const key = wordKey(term, language)
  const [existing] = bodyRows<Word>(db, 'SELECT body FROM words WHERE language=? AND normalized_term=? AND variant=?',
    key.language, key.normalizedTerm, key.variant)
  if (existing) return existing
  const word = { ...key, id: randomUUID(), term: term.trim().normalize('NFC'), createdAt, updatedAt: createdAt, revision: 1 }
  insertWord(db, word)
  return word
}

export function saveWordProgress(db: Database.Database, progress: WordProgress) {
  db.prepare('INSERT INTO word_progress VALUES (?, ?) ON CONFLICT(word_id) DO UPDATE SET body=excluded.body')
    .run(progress.wordId, JSON.stringify(progress))
}

export function insertCardLink(db: Database.Database, link: WordCardLink) {
  db.prepare('INSERT INTO word_cards VALUES (?, ?, ?, ?)').run(link.cardId, link.wordId, link.direction, Number(link.active))
}

export function cardLinks(db: Database.Database) {
  return (db.prepare('SELECT card_id AS cardId, word_id AS wordId, direction, active FROM word_cards ORDER BY card_id')
    .all() as (Omit<WordCardLink, 'active'> & { active: number })[]).map((link) => ({ ...link, active: !!link.active }))
}

export function compareLegacyCards(a: ReviewCard, b: ReviewCard) {
  return (b.schedulerState.lastReviewAt ?? b.updatedAt) - (a.schedulerState.lastReviewAt ?? a.updatedAt)
    || b.revision - a.revision || a.id.localeCompare(b.id, 'en')
}

/** Import v4–v7 identity from immutable context where available. Old term changes without a
 * reliable spelling are isolated under an audit-only identity, so they cannot schedule a different term. */
export function backfillWordHistory(db: Database.Database) {
  const entries = new Map(bodyRows<Entry>(db, 'SELECT body FROM entries ORDER BY id').map((entry) => [entry.id, entry]))
  const legacy = new Map<string, Word>()
  function historicalWord(entry: Entry) {
    const existing = legacy.get(entry.id)
    if (existing) return existing
    const word = { ...wordKey(entry.term), term: entry.term.trim().normalize('NFC'), variant: 'legacy:' + entry.id,
      id: randomUUID(), createdAt: entry.createdAt, updatedAt: entry.updatedAt, revision: 1 }
    insertWord(db, word)
    legacy.set(entry.id, word)
    return word
  }

  const progress = new Map<string, WordProgress>()
  const practiceLink = db.prepare('UPDATE practice_events SET word_id=? WHERE id=?')
  for (const event of bodyRows<PracticeEvent>(db, 'SELECT body FROM practice_events ORDER BY id')) {
    const entry = entries.get(event.entryId)!
    const wordId = entry.termChangedAt !== undefined && event.startedAt <= entry.termChangedAt
      ? historicalWord(entry).id : entry.wordId!
    practiceLink.run(wordId, event.id)
    if (event.outcome === 'completed' && event.source !== 'free') {
      progress.set(wordId, recordWordCompletion(progress.get(wordId), wordId, event.completedAt))
    }
  }
  for (const value of progress.values()) saveWordProgress(db, value)

  const spellingLink = db.prepare('UPDATE spelling_attempts SET word_id=? WHERE id=?')
  for (const attempt of bodyRows<SpellingAttempt>(db, 'SELECT body FROM spelling_attempts ORDER BY id')) {
    const entry = entries.get(attempt.entryId)!
    const wordId = attempt.termChangedAt === entry.termChangedAt ? entry.wordId! : historicalWord(entry).id
    spellingLink.run(wordId, attempt.id)
  }

  const groups = new Map<string, ReviewCard[]>()
  const chain = db.prepare('SELECT body FROM review_events WHERE card_id=? ORDER BY reviewed_at, id').pluck()
  for (const card of bodyRows<ReviewCard>(db, 'SELECT body FROM review_cards ORDER BY id')) {
    const events = (chain.all(card.id) as string[]).map((body) => JSON.parse(body) as ReviewEvent)
    const last = events.at(-1)
    if (events.length !== card.revision || !last || last.id !== card.lastEventId
      || card.createdAt !== events[0].reviewedAt || card.dueAt !== card.schedulerState.dueAt
      || card.scheduleStatus !== card.schedulerState.scheduleStatus
      || !sameReviewState(card.schedulerState, last.resultingCardState)
      || events.some((event, index) => index === 0 ? !!event.previousCardState
        : !event.previousCardState || event.reviewedAt <= events[index - 1].reviewedAt
          || !sameReviewState(event.previousCardState, events[index - 1].resultingCardState))) {
      throw new Error(`Cannot migrate the inconsistent FSRS chain ${card.id}. Run the vocabulary migration preflight on a backup.`)
    }
    const entry = entries.get(card.entryId)!
    const wordId = entry.termChangedAt !== undefined && card.createdAt <= entry.termChangedAt
      ? historicalWord(entry).id : entry.wordId!
    const group = groups.get(wordId)
    if (group) group.push(card)
    else groups.set(wordId, [card])
  }
  const isolated = new Set([...legacy.values()].map(({ id }) => id))
  for (const [wordId, cards] of groups) {
    cards.sort(compareLegacyCards)
    cards.forEach(({ id }, index) => insertCardLink(db, { wordId, cardId: id, direction: REVIEW_DIRECTION,
      active: index === 0 && !isolated.has(wordId) }))
  }
}
