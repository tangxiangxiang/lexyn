import type { LibraryChange, LibraryExport, OutboxChange } from '../../../shared/contracts/library'
import { cleanDeck, cleanEntry, LibraryError, normalizeTerm } from '../../../shared/domain/library'
import type { Deck, DeckInput, Entry, EntryInput } from '../../../shared/domain/library'
import { db, type DeckRecord, type EntryRecord, type LexynLocalDatabase } from '../../db/local'
import { createReviewScheduler, schedulerConfigSnapshot } from '../../../shared/srs/scheduler'
import type { DuplicateMode, ImportPreview } from './import'

const sequenceKey = 'library.outbox.sequence'

function deckSnapshot({ serverRevision: _, ...deck }: DeckRecord): Deck {
  return deck
}

function entrySnapshot({ serverRevision: _, activeTerm: _active, ...entry }: EntryRecord): Entry {
  return entry
}

function newEntity(now: number) {
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, revision: 1 }
}

function revise<T extends { updatedAt: number; revision: number }>(record: T, now: number): T {
  return { ...record, updatedAt: Math.max(record.updatedAt, now), revision: record.revision + 1 }
}

function checkRevision(actual: number, expected?: number) {
  if (expected !== undefined && actual !== expected) {
    throw new LibraryError('This item changed while you were editing. Close the editor and reopen it.')
  }
}

function deckChange(kind: Extract<LibraryChange, { payload: Deck }>['kind'], record: DeckRecord) {
  return { kind, payload: deckSnapshot(record), baseServerRevision: record.serverRevision }
}

function entryChange(kind: Extract<LibraryChange, { payload: Entry }>['kind'], record: EntryRecord) {
  return { kind, payload: entrySnapshot(record), baseServerRevision: record.serverRevision }
}

export async function appendOutboxOperations(database: LexynLocalDatabase, changes: OutboxChange[], now: number) {
  if (!changes.length) return
  const previous = Number((await database.sync_meta.get(sequenceKey))?.value ?? 0)
  if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(previous + changes.length)) {
    throw new LibraryError('The local operation log cannot allocate a sequence.')
  }
  await database.client_outbox.bulkAdd(changes.map((change, index) => {
    const opId = crypto.randomUUID()
    const isStudyEvent = change.kind === 'practice.create' || change.kind === 'review.create'
    return {
      ...change,
      operationId: opId,
      opId,
      schemaVersion: 1,
      entityId: change.kind === 'practice.create' ? change.payload.entryId
        : change.kind === 'review.create' ? change.payload.cardId : change.payload.id,
      baseRevision: isStudyEvent ? 0 : change.payload.revision - 1,
      sequence: previous + index + 1, createdAt: now,
    }
  }))
  await database.sync_meta.put({ key: sequenceKey, value: String(previous + changes.length) })
}

export function createLibraryRepository(database: LexynLocalDatabase) {
  const { decks, entries, client_outbox, sync_meta } = database
  const read = <T>(action: () => Promise<T>) => database.transaction('r', [decks, entries], action)
  const write = <T>(action: () => Promise<T>) =>
    database.transaction('rw', [decks, entries, client_outbox, sync_meta], action)

  async function requireDeck(id: string, active = true) {
    const deck = await decks.get(id)
    if (!deck) throw new LibraryError('This deck could not be found.')
    if (active && deck.archivedAt !== undefined) throw new LibraryError('Restore this deck before changing its words.')
    return deck
  }

  async function requireEntry(deckId: string, id: string) {
    await requireDeck(deckId)
    const entry = await entries.get(id)
    if (!entry || entry.deckId !== deckId) throw new LibraryError('This word could not be found in the deck.')
    return entry
  }

  async function ensureUnique(deckId: string, term: string, except?: string) {
    const found = await entries.where('[deckId+activeTerm]').equals([deckId, term]).first()
    if (found && found.id !== except) throw new LibraryError('This deck already has an active word with that term.')
  }

  function makeEntry(deckId: string, input: EntryInput, now: number, previous?: EntryRecord): EntryRecord {
    const cleaned = cleanEntry(input)
    const normalizedTerm = normalizeTerm(cleaned.term)
    return {
      ...(previous ? revise(previous, now) : { ...newEntity(now), deckId }),
      ...cleaned, normalizedTerm, activeTerm: normalizedTerm,
    }
  }

  return {
    listDecks: () => read(async () => {
      const summaries = new Map((await decks.toArray()).map((record) =>
        [record.id, { deck: deckSnapshot(record), count: 0, modifiedAt: record.updatedAt }]))
      await entries.each(({ deckId, updatedAt, deletedAt }) => {
        const summary = summaries.get(deckId)
        if (!summary) return
        if (deletedAt === undefined) summary.count++
        summary.modifiedAt = Math.max(summary.modifiedAt, updatedAt)
      })
      return [...summaries.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.deck.name.localeCompare(b.deck.name))
    }),

    getDeck: (id: string) => read(async () => {
      const record = await decks.get(id)
      if (!record) return null
      const words = await entries.where('deckId').equals(id).toArray()
      return {
        deck: deckSnapshot(record),
        entries: words.map(entrySnapshot).sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm)),
      }
    }),

    createDeck: (input: DeckInput) => write(async () => {
      const now = Date.now()
      const record = { ...newEntity(now), ...cleanDeck(input) }
      await decks.add(record)
      await appendOutboxOperations(database, [deckChange('deck.create', record)], now)
      return deckSnapshot(record)
    }),

    updateDeck: (id: string, input: DeckInput, expectedRevision?: number) => write(async () => {
      const now = Date.now()
      const deck = await requireDeck(id)
      checkRevision(deck.revision, expectedRevision)
      const record = { ...revise(deck, now), ...cleanDeck(input) }
      await decks.put(record)
      await appendOutboxOperations(database, [deckChange('deck.update', record)], now)
    }),

    setDeckArchived: (id: string, archived: boolean) =>
      database.transaction('rw', [decks, client_outbox, sync_meta, database.learn_sessions], async () => {
        const deck = await requireDeck(id, false)
        if ((deck.archivedAt !== undefined) === archived) return
        const now = Date.now()
        const record = { ...revise(deck, now), archivedAt: archived ? now : undefined }
        await decks.put(record)
        if (archived) {
          await database.learn_sessions.where('deckId').equals(id).and((session) => session.status === 'active')
            .modify({ status: 'paused', updatedAt: now })
        }
        await appendOutboxOperations(database, [deckChange(archived ? 'deck.archive' : 'deck.restore', record)], now)
      }),

    createEntry: (deckId: string, input: EntryInput) => write(async () => {
      await requireDeck(deckId)
      const now = Date.now()
      const record = makeEntry(deckId, input, now)
      await ensureUnique(deckId, record.normalizedTerm)
      await entries.add(record)
      await appendOutboxOperations(database, [entryChange('entry.create', record)], now)
      return entrySnapshot(record)
    }),

    updateEntry: (deckId: string, id: string, input: EntryInput, expectedRevision?: number) => write(async () => {
      const previous = await requireEntry(deckId, id)
      if (previous.deletedAt !== undefined) throw new LibraryError('Restore this word before editing it.')
      checkRevision(previous.revision, expectedRevision)
      const now = Date.now()
      const record = makeEntry(deckId, input, now, previous)
      await ensureUnique(deckId, record.normalizedTerm, id)
      await entries.put(record)
      await appendOutboxOperations(database, [entryChange('entry.update', record)], now)
    }),

    setEntryRemoved: (deckId: string, id: string, removed: boolean) => write(async () => {
      const entry = await requireEntry(deckId, id)
      if ((entry.deletedAt !== undefined) === removed) return
      if (!removed) await ensureUnique(deckId, entry.normalizedTerm, entry.id)
      const now = Date.now()
      const record = {
        ...revise(entry, now),
        deletedAt: removed ? now : undefined,
        activeTerm: removed ? undefined : entry.normalizedTerm,
      }
      await entries.put(record)
      await appendOutboxOperations(database, [entryChange(removed ? 'entry.delete' : 'entry.restore', record)], now)
    }),

    importEntries: (deckId: string, preview: ImportPreview, mode: DuplicateMode) => write(async () => {
      await requireDeck(deckId)
      const now = Date.now()
      const existing = new Map((await entries.where('deckId').equals(deckId).toArray())
        .filter((record) => record.deletedAt === undefined).map((record) => [record.normalizedTerm, record]))
      const records: EntryRecord[] = []
      const changes: OutboxChange[] = []
      const seen = new Set<string>()
      let added = 0
      let updated = 0
      for (const candidate of preview.candidates) {
        const term = normalizeTerm(candidate.input.term)
        if (term !== candidate.normalizedTerm || seen.has(term)) throw new LibraryError('Generate a new import preview.')
        seen.add(term)
        const previous = existing.get(term)
        if (previous?.id !== candidate.match?.id || previous?.revision !== candidate.match?.revision) {
          throw new LibraryError('The matching words changed. Review the updated preview and confirm again.')
        }
        if (previous && mode === 'skip') continue
        const record = makeEntry(deckId, { meaning: '', ...previous, ...candidate.input }, now, previous)
        records.push(record)
        changes.push(entryChange(previous ? 'entry.update' : 'entry.create', record))
        if (previous) updated++
        else added++
      }
      await entries.bulkPut(records)
      await appendOutboxOperations(database, changes, now)
      return { added, updated, skipped: preview.valid - added - updated, invalid: preview.invalid }
    }),

    exportLibrary: async (deckId?: string): Promise<LibraryExport> => {
      const schedulerConfig = schedulerConfigSnapshot(await createReviewScheduler())
      const { practice_events, learn_progress, preferences, review_cards, review_events } = database
      return database.transaction('r', [decks, entries, practice_events, learn_progress, preferences, review_cards, review_events], async () => {
        const records = deckId === undefined ? await decks.toArray() : [await requireDeck(deckId, false)]
        const words = deckId === undefined ? await entries.toArray() : await entries.where('deckId').equals(deckId).toArray()
        const ids = new Set(words.map(({ id }) => id))
        const allEvents = deckId === undefined ? await database.practice_events.toArray()
          : await database.practice_events.where('deckId').equals(deckId).toArray()
        const allProgress = deckId === undefined ? await database.learn_progress.toArray()
          : (await database.learn_progress.toArray()).filter(({ entryId }) => ids.has(entryId))
        return {
          format: 'lexyn-library', formatVersion: 3, exportedAt: new Date().toISOString(),
          metadata: { librarySchemaVersion: 4, scope: deckId === undefined ? 'library' : 'deck' },
          decks: records.map(deckSnapshot), entries: words.map(entrySnapshot),
          practiceEvents: allEvents.filter(({ entryId }) => ids.has(entryId)),
          learnProgress: allProgress,
          reviewCards: deckId === undefined ? await review_cards.toArray() : await review_cards.where('deckId').equals(deckId).toArray(),
          reviewEvents: deckId === undefined ? await review_events.toArray() : await review_events.where('deckId').equals(deckId).toArray(),
          schedulerConfig,
          dailyNewWords: await (async () => {
            const value = (await database.preferences.get('daily-new-words'))?.value
            return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : 10
          })(),
        }
      })
    },
  }
}

export const library = createLibraryRepository(db)
