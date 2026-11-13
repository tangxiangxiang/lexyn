import { createReadStream } from 'node:fs'
import type Database from 'better-sqlite3'
import { MAX_LIBRARY_BACKUP_BYTES, prepareLibraryRestore, type LibraryRestorePlan } from '../../shared/backup/library.ts'
import { insertList, insertMember, seedDeckLists } from '../study/lists.ts'
import { backfillWordHistory, insertWord } from '../study/words.ts'
import { createStudyStore } from '../study/store.ts'

export async function readLibraryBackup(path: string) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > MAX_LIBRARY_BACKUP_BYTES) throw new Error('The backup exceeds 64 MiB.')
    chunks.push(chunk)
  }
  return prepareLibraryRestore(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

export function restoreLibrary(db: Database.Database, { backup }: LibraryRestorePlan) {
  db.transaction(() => {
    const owner = db.prepare('SELECT id FROM owner WHERE singleton = 1').get() as { id: string } | undefined
    if (!owner) throw new Error('Initialize the Owner before restoring JSON.')
    const tables = ['decks', 'entries', 'deck_lists', 'deck_list_members', 'practice_events', 'learn_progress', 'review_events',
      'words', 'word_cards', 'word_progress', 'spelling_attempts', 'review_cards', 'learn_sessions', 'review_sessions', 'owner_settings', 'request_idempotency']
    if (tables.some((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) {
      throw new Error('JSON restore requires an empty server. Existing data was kept.')
    }
    const store = createStudyStore(db, owner.id)
    const global = 'words' in backup ? backup : undefined
    if (global) for (const word of global.words) insertWord(db, word)
    for (const value of backup.decks) store.saveDeck(value)
    for (const value of backup.entries) store.saveEntry(value, global ? value.wordId : undefined)
    if ('lists' in backup) {
      const deckByList = new Map(backup.lists.map((list) => [list.id, list.deckId]))
      for (const list of backup.lists) insertList(db, list)
      for (const member of backup.listMembers) insertMember(db, deckByList.get(member.listId)!, member)
    } else {
      seedDeckLists(db)
    }
    const practiceWords = new Map(global?.practiceWords.map(({ id, wordId }) => [id, wordId]))
    const spellingWords = new Map(global?.spellingWords.map(({ id, wordId }) => [id, wordId]))
    for (const event of backup.practiceEvents) store.addPractice(event, practiceWords.get(event.id))
    const attempts = 'spellingAttempts' in backup ? backup.spellingAttempts : []
    for (const attempt of attempts) store.addSpellingAttempt(attempt, spellingWords.get(attempt.id))
    for (const value of backup.learnProgress) store.saveProgress(value)
    for (const card of backup.reviewCards) store.saveCard(card)
    for (const event of backup.reviewEvents) store.addReview(event)
    if (global) {
      for (const progress of global.wordProgress) store.saveWordProgress(progress)
      for (const link of global.wordCards) store.linkCard(link)
    } else {
      backfillWordHistory(db)
    }
    const { dailyNewWords, timezone, studyWeekdays, reviewResetMinutes } = backup.settings
    store.saveSettings(dailyNewWords, timezone, studyWeekdays, reviewResetMinutes)
    if (backup.settings.spelling) store.saveSpellingSettings(backup.settings.spelling)
    const expected = { decks: backup.decks.length, entries: backup.entries.length, practice_events: backup.practiceEvents.length,
      spelling_attempts: attempts.length, learn_progress: backup.learnProgress.length, review_events: backup.reviewEvents.length, review_cards: backup.reviewCards.length }
    for (const [table, count] of Object.entries(expected)) {
      if (db.prepare(`SELECT count(*) AS count FROM ${table}`).pluck().get() !== count) throw new Error('Restored record count differs from the backup.')
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Restored data failed its reference check.')
  }).immediate()
}
