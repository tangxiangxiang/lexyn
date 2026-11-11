import { createReadStream } from 'node:fs'
import type Database from 'better-sqlite3'
import { MAX_LIBRARY_BACKUP_BYTES, prepareLibraryRestore, type LibraryRestorePlan } from '../../shared/backup/library.ts'
import { insertList, insertMember, seedDeckLists } from '../study/lists.ts'
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

export function restoreLibrary(db: Database.Database, { backup, reviewChanges }: LibraryRestorePlan) {
  db.transaction(() => {
    const owner = db.prepare('SELECT id FROM owner WHERE singleton = 1').get() as { id: string } | undefined
    if (!owner) throw new Error('Initialize the Owner before restoring JSON.')
    const tables = ['decks', 'entries', 'deck_lists', 'deck_list_members', 'practice_events', 'learn_progress', 'review_events',
      'review_cards', 'learn_sessions', 'review_sessions', 'owner_settings', 'request_idempotency']
    if (tables.some((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) {
      throw new Error('JSON restore requires an empty server. Existing data was kept.')
    }
    const store = createStudyStore(db, owner.id)
    for (const value of backup.decks) store.saveDeck(value)
    for (const value of backup.entries) store.saveEntry(value)
    if (backup.formatVersion === 6) {
      const deckByList = new Map(backup.lists.map((list) => [list.id, list.deckId]))
      for (const list of backup.lists) insertList(db, list)
      for (const member of backup.listMembers) insertMember(db, deckByList.get(member.listId)!, member)
    } else {
      seedDeckLists(db)
    }
    for (const event of backup.practiceEvents) store.addPractice(event)
    for (const value of backup.learnProgress) store.saveProgress(value)
    for (const { event } of reviewChanges) store.addReview(event)
    for (const { card } of reviewChanges) store.saveCard(card)
    store.saveSettings(backup.settings.dailyNewWords, backup.settings.timezone)
    const expected = { decks: backup.decks.length, entries: backup.entries.length, practice_events: backup.practiceEvents.length,
      learn_progress: backup.learnProgress.length, review_events: backup.reviewEvents.length, review_cards: backup.reviewCards.length }
    for (const [table, count] of Object.entries(expected)) {
      if (db.prepare(`SELECT count(*) AS count FROM ${table}`).pluck().get() !== count) throw new Error('Restored record count differs from the backup.')
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Restored data failed its reference check.')
  }).immediate()
}
