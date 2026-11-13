import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Entry } from '../../shared/domain/library.ts'
import type { ReviewCard, ReviewEvent } from '../../shared/domain/review.ts'
import { sameReviewState } from '../../shared/backup/library.ts'
import { wordKey, type Word } from '../../shared/domain/word.ts'
import { rebuildCardFromEvents } from '../../shared/srs/scheduler.ts'
import { migrate } from '../db/migrations/index.ts'
import { bodyRows, cardLinks } from '../study/words.ts'
import { verifySqliteBackup } from './sqlite.ts'

function audit(db: Database.Database) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").pluck().all())
  const count = (table: string, where = '') => tables.has(table)
    ? db.prepare(`SELECT count(*) FROM ${table} ${where}`).pluck().get() as number : 0
  const entries = bodyRows<Entry>(db, 'SELECT body FROM entries')
  const bookGroups = new Map<string, Set<string>>()
  for (const entry of entries) {
    const key = JSON.stringify(wordKey(entry.term))
    const books = bookGroups.get(key) ?? new Set<string>()
    books.add(entry.deckId)
    bookGroups.set(key, books)
  }
  return {
    schemaVersion: db.pragma('user_version', { simple: true }),
    decks: count('decks'), entries: entries.length, uniqueVocabularyKeys: bookGroups.size,
    sharedVocabularyKeys: [...bookGroups.values()].filter((books) => books.size > 1).length,
    legacyLearnProgress: count('learn_progress'), reviewCards: count('review_cards'),
    reviewEvents: count('review_events'), practiceEvents: count('practice_events'), spellingAttempts: count('spelling_attempts'),
    openLearnSessions: count('learn_sessions', "WHERE status IN ('active','paused')"),
    openReviewSessions: count('review_sessions', "WHERE status IN ('active','paused')"),
    words: count('words'), wordProgress: count('word_progress'), activeCards: count('word_cards', 'WHERE active=1'),
  }
}

async function verifyChains(db: Database.Database) {
  const cards = bodyRows<ReviewCard>(db, 'SELECT body FROM review_cards ORDER BY id')
  const events = db.prepare('SELECT body FROM review_events WHERE card_id=? ORDER BY reviewed_at, id').pluck()
  for (const card of cards) {
    const history = (events.all(card.id) as string[]).map((body) => JSON.parse(body) as ReviewEvent)
    if (history.length !== card.revision || history.at(-1)?.id !== card.lastEventId
      || history[0]?.reviewedAt !== card.createdAt || card.schedulerState.cardId !== card.id
      || card.schedulerState.dueAt !== card.dueAt || card.schedulerState.scheduleStatus !== card.scheduleStatus) {
      throw new Error(`Card ${card.id} has incomplete history or a mismatched projection.`)
    }
    let previous: ReviewCard['schedulerState'] | undefined
    const rebuilt = await rebuildCardFromEvents(history, (event, state) => {
      if (!sameReviewState(event.resultingCardState, state)
        || (previous ? !event.previousCardState || !sameReviewState(event.previousCardState, previous) : event.previousCardState)) {
        throw new Error(`Card ${card.id} cannot replay its original history at event ${event.id}.`)
      }
      previous = state
    })
    if (!rebuilt || !sameReviewState(card.schedulerState, rebuilt)) {
      throw new Error(`Card ${card.id} does not match its original FSRS chain.`)
    }
  }
}

export async function preflightWordMigration(directory: string) {
  const info = await verifySqliteBackup(directory)
  const scratch = await mkdtemp(join(tmpdir(), 'lexyn-word-audit-'))
  try {
    const path = join(scratch, 'lexyn.sqlite')
    const source = new Database(join(directory, 'lexyn.sqlite'), { readonly: true, fileMustExist: true })
    try { await source.backup(path) } finally { source.close() }
    const verified = await verifySqliteBackup(directory)
    if (verified.sha256 !== info.sha256) throw new Error('The source backup changed during the preflight.')
    const db = new Database(path, { fileMustExist: true })
    try {
      db.pragma('foreign_keys=ON')
      const before = audit(db)
      await verifyChains(db)
      migrate(db)
      await verifyChains(db)
      const after = audit(db)
      const words = new Map(bodyRows<Word>(db, 'SELECT body FROM words ORDER BY normalized_term, variant, id').map((word) => [word.id, word]))
      const cards = new Map(bodyRows<ReviewCard>(db, 'SELECT body FROM review_cards').map((card) => [card.id, card]))
      const links = cardLinks(db)
      const counts = new Map<string, number>()
      const spellings = new Map<string, Word[]>()
      for (const word of words.values()) {
        if (word.variant.startsWith('legacy:')) continue
        const key = JSON.stringify([word.language, word.normalizedTerm])
        const group = spellings.get(key) ?? []
        group.push(word)
        spellings.set(key, group)
      }
      for (const { wordId } of links) counts.set(wordId, (counts.get(wordId) ?? 0) + 1)
      const competing = new Map<string, { word: Word; chains: { cardId: string; active: boolean; lastReviewAt: number | null; events: number }[] }>()
      for (const { wordId, cardId, active } of links) {
        if ((counts.get(wordId) ?? 0) < 2) continue
        const group = competing.get(wordId) ?? { word: words.get(wordId)!, chains: [] }
        const card = cards.get(cardId)!
        group.chains.push({ cardId, active, lastReviewAt: card.schedulerState.lastReviewAt, events: card.revision })
        competing.set(wordId, group)
      }
      return {
        before, after,
        selectionRule: 'Latest review time, then most events, then ascending Card ID.',
        wordsWithMultipleChains: competing.size,
        competingChains: [...competing.values()],
        ambiguousCaseKeys: [...spellings.values()].filter((group) => group.length > 1),
        legacyRenames: [...words.values()].filter(({ variant }) => variant.startsWith('legacy:')).map((word) => ({
          word, retainedCards: links.filter(({ wordId }) => wordId === word.id).map(({ cardId }) => cardId),
        })),
      }
    } finally { db.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
