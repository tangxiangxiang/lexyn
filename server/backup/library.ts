import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type Database from 'better-sqlite3'
import { MAX_LIBRARY_BACKUP_BYTES, prepareLibraryRestore, type LibraryRestorePlan } from '../../shared/backup/library.ts'
import { stableJson, type SyncRecord } from '../../shared/contracts/sync.ts'
import type { LearnProgress } from '../../shared/domain/learning.ts'

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
    const tables = ['devices', 'decks', 'entries', 'practice_events', 'learn_progress', 'review_events',
      'review_cards', 'sync_operations', 'sync_changes']
    const hasData = tables.some((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
    if (hasData || db.prepare("SELECT 1 FROM app_meta WHERE key = 'restored_daily_new_words'").get()) {
      throw new Error('JSON restore requires an empty server without sync history. Existing data was kept.')
    }
    // The historical events need a device FK, but the backup has no credentials or device identity.
    const device = randomUUID()
    db.prepare('INSERT INTO devices (id, owner_id, last_seen_at) VALUES (?, ?, ?)').run(device, owner.id, Date.now())
    const change = db.prepare('INSERT INTO sync_changes (body) VALUES (?)')
    const publish = (record: SyncRecord) => change.run(stableJson(record))
    const deck = db.prepare('INSERT INTO decks (id, body, revision, device_id, local_revision) VALUES (?, ?, 1, ?, ?)')
    for (const value of backup.decks) {
      deck.run(value.id, stableJson(value), device, value.revision)
      publish({ kind: 'deck', value, serverRevision: 1 })
    }
    const entry = db.prepare('INSERT INTO entries (id, deck_id, active_term, body, revision, device_id, local_revision) VALUES (?, ?, ?, ?, 1, ?, ?)')
    for (const value of backup.entries) {
      entry.run(value.id, value.deckId, value.deletedAt === undefined ? value.normalizedTerm : null, stableJson(value), device, value.revision)
      publish({ kind: 'entry', value, serverRevision: 1 })
    }
    const practice = db.prepare('INSERT INTO practice_events VALUES (?, ?, ?, ?)')
    const progress = new Map<string, LearnProgress>()
    for (const event of backup.practiceEvents) {
      practice.run(event.id, event.entryId, device, stableJson(event))
      let result: LearnProgress | undefined
      if (event.outcome === 'completed') {
        const previous = progress.get(event.entryId)
        result = { entryId: event.entryId, firstCompletedAt: Math.min(previous?.firstCompletedAt ?? event.completedAt, event.completedAt),
          lastPracticedAt: Math.max(previous?.lastPracticedAt ?? event.completedAt, event.completedAt), completedCount: (previous?.completedCount ?? 0) + 1 }
        progress.set(event.entryId, result)
      }
      publish({ kind: 'practice', event, progress: result })
    }
    const addProgress = db.prepare('INSERT INTO learn_progress VALUES (?, ?)')
    for (const value of backup.learnProgress) addProgress.run(value.entryId, stableJson(value))
    const review = db.prepare('INSERT INTO review_events VALUES (?, ?, ?, ?, ?, ?)')
    const addCard = db.prepare(`INSERT INTO review_cards VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, body=excluded.body`)
    for (const { event, card } of reviewChanges) {
      const { effectiveReviewedAt, ...original } = event
      review.run(event.id, event.entryId, event.cardId, device, effectiveReviewedAt ?? event.reviewedAt, stableJson(original))
      addCard.run(card.id, card.entryId, card.direction, card.revision, stableJson(card))
      publish({ kind: 'review', event, card })
    }
    db.prepare("INSERT INTO app_meta VALUES ('restored_daily_new_words', ?)").run(String(backup.dailyNewWords))
    const expected = { decks: backup.decks.length, entries: backup.entries.length, practice_events: backup.practiceEvents.length,
      learn_progress: backup.learnProgress.length, review_events: backup.reviewEvents.length, review_cards: backup.reviewCards.length,
      sync_changes: backup.decks.length + backup.entries.length + backup.practiceEvents.length + backup.reviewEvents.length }
    for (const [table, count] of Object.entries(expected)) {
      if (db.prepare(`SELECT count(*) AS count FROM ${table}`).pluck().get() !== count) throw new Error('Restored record count differs from the backup.')
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Restored data failed its reference check.')
  }).immediate()
}
