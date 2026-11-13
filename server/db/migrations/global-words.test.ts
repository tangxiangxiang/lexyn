import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { prepareLibraryRestore } from '../../../shared/backup/library.ts'
import type { Entry } from '../../../shared/domain/library.ts'
import type { PracticeEvent } from '../../../shared/domain/learning.ts'
import { REVIEW_DIRECTION, reviewCardId, type ReviewCard, type ReviewEvent } from '../../../shared/domain/review.ts'
import { createReviewScheduler, rebuildCardFromEvents, schedulerConfigSnapshot, schedulerGrades, serializeCard, serializeRevlog } from '../../../shared/srs/scheduler.ts'
import { initializeOwner } from '../../auth/owner.ts'
import { restoreLibrary } from '../../backup/library.ts'
import { createSqliteBackup } from '../../backup/sqlite.ts'
import { preflightWordMigration } from '../../backup/word-migration.ts'
import { createLibraryService } from '../../study/library.ts'
import { seedDeckLists } from '../../study/lists.ts'
import { createReviewService } from '../../study/review.ts'
import { createStudyStore } from '../../study/store.ts'
import { cardLinks, findWord } from '../../study/words.ts'
import { openDatabase } from '../database.ts'
import { migrate } from './index.ts'

test('uses stable NFC keys, protects ambiguous abbreviations and isolates languages', () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    expect(findWord(db, ' Café ', 1).id).toBe(findWord(db, 'CAFE\u0301', 2).id)
    expect(findWord(db, 'apple', 1).id).toBe(findWord(db, 'Apple', 2).id)
    for (const [left, right] of [['apple', 'apples'], ['US', 'us'], ['run', 'running'], ['ice cream', 'ice-cream'], ["can't", 'cant']]) {
      expect(findWord(db, left, 1).id).not.toBe(findWord(db, right, 1).id)
    }
    expect(findWord(db, 'chat', 1, 'fr').id).not.toBe(findWord(db, 'chat', 1, 'en').id)
  } finally { db.close() }
})

test('audits and upgrades v12, preserves competing FSRS chains and resumes existing sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexyn-global-words-'))
  const db = openDatabase(join(root, 'legacy'), 12)
  const restored = new Database(':memory:')
  restored.pragma('foreign_keys=ON')
  try {
    const password = 'test-owner-password'
    await initializeOwner(db, 'test-admin', password)
    const owner = db.prepare('SELECT id FROM owner').pluck().get() as string
    const store = createStudyStore(db, owner)
    const engine = await createReviewScheduler()
    const config = schedulerConfigSnapshot(engine)
    const t = Date.parse('2026-01-01T00:00:00Z')
    const day = 86400000
    const deck = (name: string, archivedAt?: number) => {
      const row = { id: randomUUID(), name, revision: 1, createdAt: t, updatedAt: t, archivedAt }
      store.saveDeck(row)
      return row.id
    }
    const a = deck('A')
    const b = deck('B', t + 6 * day)
    function add(deckId: string, term: string, meaning: string, overrides?: Partial<Entry>) {
      const row = { id: randomUUID(), deckId, term, meaning, normalizedTerm: term.toLowerCase(), revision: 1,
        createdAt: t, updatedAt: t, ...overrides }
      db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)')
        .run(row.id, deckId, row.deletedAt === undefined ? row.normalizedTerm : null, JSON.stringify(row), row.revision)
      return row
    }
    const appleA = add(a, 'Apple', '苹果')
    const appleB = add(b, 'apple', '苹果公司', { deletedAt: t + 5 * day })
    const pearA = add(a, 'pear', '梨')
    const pearB = add(b, 'pear', '梨子')
    const grapeA = add(a, 'grape', '葡萄')
    const grapeB = add(b, 'grape', '提子')
    const renamed = add(a, 'orange', '橙子', { termChangedAt: t + 7 * day })
    add(a, 'US', '美国')
    add(b, 'us', '我们')
    seedDeckLists(db)
    const membership = db.prepare('SELECT * FROM deck_list_members ORDER BY list_id, position').all()
    function learn(entry: Entry, completedAt: number) {
      const event: PracticeEvent = { id: randomUUID(), deckId: entry.deckId, entryId: entry.id, sessionId: randomUUID(),
        mode: 'copy', outcome: 'completed', attempts: 1, firstTryCorrect: true, assisted: false, startedAt: completedAt, completedAt }
      db.prepare('INSERT INTO practice_events VALUES (?, ?, ?)').run(event.id, entry.id, JSON.stringify(event))
      const progress = { entryId: entry.id, firstCompletedAt: completedAt, lastPracticedAt: completedAt, completedCount: 1 }
      db.prepare('INSERT INTO learn_progress VALUES (?, ?)').run(entry.id, JSON.stringify(progress))
    }
    learn(appleA, t)
    learn(appleB, t + day)
    learn(pearA, t)
    learn(renamed, t)
    const attempt = { id: randomUUID(), entryId: appleA.id, sessionId: randomUUID(), round: 0, attempt: 1,
      spelling: 'apple', time: t, source: 'learn', mode: 'copy', keyboard: 'full', assisted: false, correct: true, errors: [] }
    db.prepare('INSERT INTO spelling_attempts VALUES (?, ?, ?, ?, ?, ?)').run(attempt.id, appleA.id, attempt.sessionId, 0, 1, JSON.stringify(attempt))

    function chain(entry: Entry, days: number[]) {
      const cardId = reviewCardId(entry.id)
      let previous: ReturnType<typeof engine.newCard> | undefined
      let previousState: ReviewCard['schedulerState'] | undefined
      const events = days.map((offset) => {
        const reviewedAt = t + offset * day
        const now = new Date(reviewedAt)
        const rating = 'good'
        const result = engine.review({ card: previous ?? engine.newCard({ now, cardId }), grade: schedulerGrades[rating], now })
        const event: ReviewEvent = { id: randomUUID(), cardId, entryId: entry.id, deckId: entry.deckId, sessionId: randomUUID(),
          direction: REVIEW_DIRECTION, rating, reviewedAt, schedulerModel: 'FSRS-7', schedulerConfigVersion: config.version,
          schedulerConfigSnapshot: config, previousCardState: previousState, resultingCardState: serializeCard(result.card),
          schedulerRevlog: serializeRevlog(result.revlog, rating) }
        previous = result.card
        previousState = event.resultingCardState
        return event
      })
      const last = events.at(-1)!
      const card: ReviewCard = { id: cardId, entryId: entry.id, deckId: entry.deckId, direction: REVIEW_DIRECTION,
        revision: events.length, lastEventId: last.id, createdAt: events[0].reviewedAt, updatedAt: last.reviewedAt,
        schedulerConfigVersion: config.version, schedulerState: last.resultingCardState, dueAt: last.resultingCardState.dueAt,
        scheduleStatus: last.resultingCardState.scheduleStatus }
      store.saveCard(card)
      for (const event of events) store.addReview(event)
      return { card, events }
    }

    const first = chain(appleA, [2, 4])
    const newer = chain(appleB, [3, 5])
    const pear = chain(pearA, [2])
    const oldTerm = chain(renamed, [2])
    const now = t + 60 * day
    const oldReview = store.saveReview({ sessionId: randomUUID(), entryIds: [appleA.id, appleB.id], currentIndex: 0,
      currentCardId: first.card.id, currentRevealed: true, revealedEntryRevision: 1, startedAt: now, updatedAt: now, status: 'active' })
    const oldLearn = store.saveLearn({ sessionId: randomUUID(), deckId: a, mode: 'copy', entryIds: [grapeA.id], currentIndex: 0,
      startedAt: now, updatedAt: now, status: 'paused', dailyKey: '2026-03-02', firstCompletedEntryIds: [],
      currentEntryStartedAt: now, currentAttempts: 0, currentAssisted: false })
    const history = () => ['review_cards', 'review_events', 'practice_events', 'spelling_attempts']
      .map((table) => db.prepare(`SELECT body FROM ${table} ORDER BY id`).pluck().all())
    const before = history()
    const saved = await createSqliteBackup(join(root, 'legacy'), join(root, 'backups'))
    const report = await preflightWordMigration(saved.directory)
    expect(report.before).toMatchObject({ schemaVersion: 12, decks: 2, entries: 9, sharedVocabularyKeys: 3, reviewCards: 4,
      reviewEvents: 6, spellingAttempts: 1, openLearnSessions: 1, openReviewSessions: 1 })
    expect(report.after).toMatchObject({ schemaVersion: 13, reviewCards: 4, activeCards: 2 })
    expect(report.wordsWithMultipleChains).toBe(1)
    expect(report.competingChains[0].chains).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: first.card.id, active: false }),
      expect.objectContaining({ cardId: newer.card.id, active: true }),
    ]))
    expect(report.ambiguousCaseKeys).toHaveLength(1)
    expect(report.legacyRenames[0].retainedCards).toEqual([oldTerm.card.id])
    expect(db.pragma('user_version', { simple: true })).toBe(12)

    migrate(db)
    migrate(db)
    expect(history()).toEqual(before)
    expect(db.prepare('SELECT * FROM deck_list_members ORDER BY list_id, position').all()).toEqual(membership)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    const word = store.entry(appleA.id)!.wordId!
    expect(store.entry(appleB.id)).toMatchObject({ wordId: word, meaning: '苹果公司' })
    expect(store.wordProgress(word)).toEqual({ wordId: word, firstCompletedAt: t, lastPracticedAt: t + day, completedCount: 2 })
    expect(store.entry(pearA.id)?.wordId).toBe(store.entry(pearB.id)?.wordId)
    expect(store.activeCard(store.entryWord(pearB.id))).toEqual(pear.card)
    expect(store.entryWord(grapeA.id)).toBe(store.entryWord(grapeB.id))
    expect(store.entryProgress(grapeB.id)).toBeUndefined()
    expect(store.entryProgress(renamed.id)).toBeUndefined()
    expect(store.activeCard(store.entryWord(renamed.id))).toBeUndefined()
    expect(store.activeCard(word)).toEqual(newer.card)
    expect(store.learn(oldLearn.sessionId)).toMatchObject({ status: 'paused', entryWords: { [grapeA.id]: store.entryWord(grapeA.id) } })
    const review = createReviewService(store, engine)
    expect(review.round(undefined, now, oldReview.sessionId)).toMatchObject({
      session: { status: 'active', currentIndex: 0, currentCardId: newer.card.id }, revealed: true, word: { answer: { id: appleA.id } },
    })
    for (const { card, events } of [first, newer, pear, oldTerm]) {
      expect(await rebuildCardFromEvents(events)).toEqual(card.schedulerState)
    }

    const exported = createLibraryService(store, config).exportLibrary()
    expect(exported.formatVersion).toBe(8)
    migrate(restored)
    await initializeOwner(restored, 'test-admin', password)
    restoreLibrary(restored, await prepareLibraryRestore(JSON.stringify(exported)))
    const newOwner = restored.prepare('SELECT id FROM owner').pluck().get() as string
    const imported = createLibraryService(createStudyStore(restored, newOwner), config).exportLibrary()
    expect({ ...imported, exportedAt: exported.exportedAt }).toEqual(exported)
    expect(cardLinks(restored)).toEqual(cardLinks(db))
  } finally { db.close(); restored.close(); await rm(root, { recursive: true, force: true }) }
})
