import { randomUUID } from 'node:crypto'
import { hasFinalMeaning } from '../../shared/domain/dictionary.ts'
import { builtinWordbookById, builtinWordbookDescription, type BuiltinWordbookId, type BuiltinWordbookTag } from '../../shared/domain/builtin-books.ts'
import type { SpellingAttempt } from '../../shared/domain/spelling.ts'
import type { DictionaryEntry } from '../../shared/contracts/dictionary.ts'
import { libraryFormatVersion, type LibraryExport } from '../../shared/contracts/library.ts'
import { stableJson } from '../../shared/contracts/json.ts'
import { cleanDeck, cleanEntry, normalizeTerm, type DeckListSummary, type Deck, type DeckInput, type Entry, type EntryInput } from '../../shared/domain/library.ts'
import type { LearnProgress, PracticeEvent } from '../../shared/domain/learning.ts'
import type { ReviewEvent, ReviewSchedulerConfig } from '../../shared/domain/review.ts'
import { manualMeaningFromImport, type DuplicateMode, type ImportPreview } from '../../shared/domain/library-import.ts'
import { recordWordCompletion, wordKey, type Word, type WordHistoryLink, type WordProgress } from '../../shared/domain/word.ts'
import { cardLinks } from './words.ts'
import { checkRevision, StudyError, type StudyStore } from './store.ts'

const newEntity = (now: number) => ({ id: randomUUID(), createdAt: now, updatedAt: now, revision: 1 })
const revise = <T extends Deck | Entry>(value: T, now: number) =>
  ({ ...value, updatedAt: Math.max(value.updatedAt, now), revision: value.revision + 1 })

function legacyDictionaryReference(entry?: Entry) {
  const meaning = entry?.dictionaryMeaning
  if (!meaning?.sourceWord || meaning.rawTranslation === undefined) return undefined
  return { sourceWord: meaning.sourceWord, sourceRevision: meaning.sourceRevision, translation: meaning.rawTranslation,
    definition: '', partOfSpeech: '', phonetic: '' }
}

function listProgress(lists: DeckListSummary[], activeListId?: string) {
  const active = lists.filter(({ count }) => count > 0)
  const completed = active.filter(({ count, learned }) => count === learned).length
  return { listCount: active.length, completedLists: completed,
    learnedCount: active.reduce((sum, list) => sum + list.learned, 0),
    activeListId, nextListId: (active.find(({ id }) => id === activeListId) ?? active.find(({ count, learned }) => learned < count) ?? active.at(-1))?.id }
}

export function createLibraryService(store: StudyStore, config: ReviewSchedulerConfig) {
  function requireDeck(id: string, active = true) {
    const deck = store.deck(id)
    if (!deck) throw new StudyError('Deck not found.', 404)
    if (active && deck.archivedAt !== undefined) throw new StudyError('Restore this deck before changing its words.', 409)
    return deck
  }
  function requireEntry(deckId: string, id: string) {
    requireDeck(deckId)
    const entry = store.entry(id)
    if (!entry || entry.deckId !== deckId) throw new StudyError('Word not found in this deck.', 404)
    return entry
  }
  function unique(deckId: string, term: string, except?: string) {
    const entry = store.activeEntry(deckId, term)
    if (entry && entry.id !== except) throw new StudyError('This deck already has an active word with that term.', 409)
  }
  function makeEntry(deckId: string, input: EntryInput, now: number, previous?: Entry): Entry {
    const sameTerm = previous !== undefined && stableJson(wordKey(previous.term)) === stableJson(wordKey(input.term))
    const termChanged = previous !== undefined && !sameTerm
    const supplied = termChanged ? null : input.dictionaryMeaning
    const legacyChanged = sameTerm && supplied === undefined && previous.meaning !== input.meaning && hasFinalMeaning(previous.dictionaryMeaning)
    const legacyEdit = legacyChanged && input.meaning.trim() && input.meaning.length <= 1000
      ? { senses: [{ partOfSpeech: '', definitions: [input.meaning], source: 'manual' as const }] } : undefined
    const dictionaryMeaning = termChanged ? undefined
      : supplied === undefined && sameTerm ? (legacyChanged ? legacyEdit : previous?.dictionaryMeaning) : supplied
    const dictionaryReference = termChanged ? undefined : input.dictionaryReference === undefined && sameTerm
      ? previous?.dictionaryReference ?? legacyDictionaryReference(previous) : input.dictionaryReference
    const phonetics = termChanged ? undefined : input.phonetics === undefined && sameTerm ? previous?.phonetics : input.phonetics
    const fields = cleanEntry({ ...input,
      meaning: termChanged ? '' : input.meaning,
      explanation: input.explanation ?? previous?.explanation,
      example: input.example ?? previous?.example,
      note: input.note ?? previous?.note,
      pronunciationOverride: termChanged ? '' : input.pronunciationOverride ?? previous?.pronunciationOverride,
      phonetic: termChanged || input.phonetics === null ? '' : input.phonetic ?? previous?.phonetic,
      dictionaryMeaning, dictionaryReference, phonetics })
    const hasPhonetics = !!(fields.phonetics || fields.phonetic)
    const phoneticsCleared = !termChanged && !hasPhonetics
      && (input.phonetics === null || (sameTerm && (previous.phoneticsCleared || !!previous.phonetic)))
    const phoneticsUnchanged = sameTerm && fields.phonetic === previous.phonetic
      && stableJson(fields.phonetics) === stableJson(previous.phonetics)
    const normalizedTerm = normalizeTerm(fields.term)
    const sameMeaning = sameTerm && previous?.meaning === fields.meaning
    const meaningSource = fields.meaning ? (sameMeaning ? previous.meaningSource : input.meaningSource ?? 'manual') : undefined
    const needsReview = sameMeaning ? previous.meaningNeedsReview : input.meaningNeedsReview
    return {
      ...(previous ? revise(previous, now) : { ...newEntity(now), deckId }),
      ...fields, dictionaryMeaning: fields.dictionaryMeaning ?? undefined,
      dictionaryReference: fields.dictionaryReference ?? undefined, phonetics: fields.phonetics ?? undefined, normalizedTerm,
      phoneticsCleared: phoneticsCleared || undefined,
      phoneticsNeedsReview: phoneticsUnchanged && !phoneticsCleared ? previous.phoneticsNeedsReview : undefined,
      meaningSource, meaningNeedsReview: (meaningSource === 'ai' || meaningSource === 'dictionary') && needsReview ? true : undefined,
      termChangedAt: termChanged ? now : previous?.termChangedAt,
    }
  }

  return {
    builtinBooks(catalog: { installed: boolean; books: { id: BuiltinWordbookId; name: string; count: number; available: boolean }[] }) {
      const decks = store.decks()
      return { ...catalog, books: catalog.books.map((book) => ({
        ...book,
        ...(() => {
          const deck = decks.find(({ description }) => description === builtinWordbookDescription(book.id))
          return deck ? { deckId: deck.id, deckArchived: deck.archivedAt !== undefined } : {}
        })(),
      })) }
    },
    createBuiltinBook(id: BuiltinWordbookId, rows: DictionaryEntry[] | undefined, now: number, selectedTags: BuiltinWordbookTag[]) {
      const book = builtinWordbookById[id]
      if (!book?.tag) throw new StudyError('This built-in wordbook is not available from the installed dictionary.', 404)
      if (!rows) throw new StudyError('ECDICT is not installed on this server.', 404)
      if (!selectedTags.length) throw new StudyError('Choose at least one word group.', 400)
      if (!rows.length) throw new StudyError('No words match the selected word groups.', 404)

      const description = builtinWordbookDescription(id)
      const previous = store.decks().find((deck) => deck.description === description)
      const deck = previous
        ? previous.archivedAt === undefined ? previous : { ...revise(previous, now), archivedAt: undefined }
        : { ...newEntity(now), ...cleanDeck({ name: book.name, description, listSize: 30 }) }
      if (!previous || deck !== previous) store.saveDeck(deck)
      const entryIds: string[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        const normalized = normalizeTerm(row.word)
        if (!normalized || seen.has(normalized) || store.activeEntry(deck.id, normalized) || !row.translation.trim()) continue
        seen.add(normalized)
        const entry = makeEntry(deck.id, {
          term: row.word,
          meaning: row.translation,
          dictionaryMeaning: row.dictionaryMeaning,
          dictionaryReference: {
            sourceWord: row.word,
            sourceRevision: row.dictionaryMeaning?.sourceRevision,
            translation: row.translation,
            definition: row.definition,
            partOfSpeech: row.pos,
            phonetic: row.phonetic,
          },
          phonetic: row.phonetic,
          meaningSource: 'dictionary',
          meaningNeedsReview: true,
        }, now)
        store.saveEntry(entry)
        entryIds.push(entry.id)
      }
      store.lists.append(deck, entryIds)
      const count = store.entries(deck.id).filter(({ deletedAt }) => deletedAt === undefined).length
      return { deck, count, addedCount: entryIds.length, alreadyAdded: entryIds.length === 0 }
    },
    listDecks(offset: number, limit: number) {
      const counts = store.db.prepare(`SELECT deck_id AS deckId, COUNT(active_term) AS count,
        MAX(json_extract(body, '$.updatedAt')) AS modifiedAt FROM entries GROUP BY deck_id`).all() as { deckId: string; count: number; modifiedAt: number }[]
      const byDeck = new Map(counts.map((row) => [row.deckId, row]))
      const lists = new Map<string, DeckListSummary[]>()
      for (const list of store.lists.summaries()) {
        const groups = lists.get(list.deckId)
        if (groups) groups.push(list)
        else lists.set(list.deckId, [list])
      }
      const session = store.openLearn()
      return store.decks().map((deck) => {
        const count = byDeck.get(deck.id)
        const groups = lists.get(deck.id) ?? []
        return { deck, count: count?.count ?? 0, modifiedAt: Math.max(deck.updatedAt, count?.modifiedAt ?? 0),
          ...listProgress(groups, session?.deckId === deck.id ? session.listId : undefined) }
      }).sort((a, b) => b.modifiedAt - a.modifiedAt || a.deck.id.localeCompare(b.deck.id))
        .slice(offset, offset + limit)
    },
    getLists(deckId: string) {
      const deck = store.deck(deckId)
      if (!deck) return null
      const lists = store.lists.summaries(deckId)
      const session = store.openLearn()
      return { deck, lists, ...listProgress(lists, session?.deckId === deckId ? session.listId : undefined) }
    },
    getList(deckId: string, listId: string) {
      if (!store.lists.get(deckId, listId)) throw new StudyError('List not found in this deck.', 404)
      return store.lists.entries(deckId, listId)
    },
    renameList(deckId: string, listId: string, name: string) {
      requireDeck(deckId)
      if (!name.trim()) throw new StudyError('Enter a list name.')
      const result = store.db.prepare('UPDATE deck_lists SET name=? WHERE id=? AND deck_id=?').run(name.trim(), listId, deckId)
      if (!result.changes) throw new StudyError('List not found in this deck.', 404)
    },
    getDeck(id: string, query: string, filter: 'active' | 'missing' | 'dictionary' | 'review' | 'removed' | 'all', offset: number, limit: number) {
      const deck = store.deck(id)
      if (!deck) return null
      const words = store.entries(id)
      const text = normalizeTerm(query)
      const matches = words.filter((word) => {
        if (filter !== 'all' && (word.deletedAt !== undefined) !== (filter === 'removed')) return false
        if (filter === 'missing' && word.meaning.trim()) return false
        if (filter === 'dictionary' && hasFinalMeaning(word.dictionaryMeaning)) return false
        if (filter === 'review' && !word.meaningNeedsReview && !word.phoneticsNeedsReview) return false
        return !text || word.normalizedTerm.includes(text) || normalizeTerm(word.meaning).includes(text)
          || !!word.dictionaryMeaning?.senses.some(({ definitions }) => definitions.some((meaning) => normalizeTerm(meaning).includes(text)))
      }).sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm) || a.id.localeCompare(b.id))
      return { deck, entries: matches.slice(offset, offset + limit), total: matches.length,
        activeCount: words.filter((word) => word.deletedAt === undefined).length }
    },
    createDeck(input: DeckInput, now: number) {
      const deck = { ...newEntity(now), ...cleanDeck(input) }
      store.saveDeck(deck)
      return deck
    },
    updateDeck(id: string, input: DeckInput, revision: number, now: number) {
      const deck = requireDeck(id)
      checkRevision(deck, revision)
      store.saveDeck({ ...revise(deck, now), ...cleanDeck({ ...input, listSize: input.listSize ?? deck.listSize }) })
    },
    setDeckArchived(id: string, archived: boolean, revision: number, now: number) {
      const deck = requireDeck(id, false)
      checkRevision(deck, revision)
      if ((deck.archivedAt !== undefined) === archived) return
      store.saveDeck({ ...revise(deck, now), archivedAt: archived ? now : undefined })
      if (!archived) return
      for (const source of ['learn', 'free'] as const) {
        const session = store.openLearn(source)
        if (session?.deckId === id && session.status === 'active') store.saveLearn({ ...session, status: 'paused', updatedAt: now })
      }
    },
    createEntry(deckId: string, input: EntryInput, now: number) {
      const deck = requireDeck(deckId)
      const entry = makeEntry(deckId, input, now)
      unique(deckId, entry.normalizedTerm)
      const saved = store.saveEntry(entry)
      store.lists.append(deck, [saved.id])
      return saved
    },
    updateEntry(deckId: string, id: string, input: EntryInput, revision: number, now: number) {
      const previous = requireEntry(deckId, id)
      checkRevision(previous, revision)
      if (previous.deletedAt !== undefined) throw new StudyError('Restore this word before editing it.', 409)
      const entry = makeEntry(deckId, { ...input, explanation: input.explanation ?? previous.explanation }, now, previous)
      unique(deckId, entry.normalizedTerm, id)
      return store.saveEntry(entry)
    },
    setEntryRemoved(deckId: string, id: string, removed: boolean, revision: number, now: number) {
      const entry = requireEntry(deckId, id)
      checkRevision(entry, revision)
      if ((entry.deletedAt !== undefined) === removed) return
      if (!removed) unique(deckId, entry.normalizedTerm, id)
      store.saveEntry({ ...revise(entry, now), deletedAt: removed ? now : undefined })
    },
    importEntries(deckId: string, candidates: ImportPreview['candidates'], mode: DuplicateMode, now: number, listSize?: number) {
      const deck = requireDeck(deckId)
      const newEntries: string[] = []
      const seen = new Set<string>()
      let added = 0
      let updated = 0
      let skipped = 0
      for (const candidate of candidates) {
        const term = normalizeTerm(candidate.input.term)
        if (term !== candidate.normalizedTerm || seen.has(term)) throw new StudyError('Generate a new import preview.')
        seen.add(term)
        const previous = store.activeEntry(deckId, term)
        if (previous?.id !== candidate.match?.id || previous?.revision !== candidate.match?.revision) {
          throw new StudyError('The matching words changed. Review the updated preview and confirm again.', 409)
        }
        if (previous && mode === 'skip') { skipped++; continue }
        const meaningMapped = Object.hasOwn(candidate.input, 'meaning')
        const importedMeaning = meaningMapped ? candidate.input.meaning?.trim() ?? '' : undefined
        const replaceMeaning = !!importedMeaning && importedMeaning !== previous?.meaning
        const input: EntryInput = {
          ...candidate.input,
          meaning: replaceMeaning ? importedMeaning! : previous?.meaning ?? importedMeaning ?? '',
          dictionaryMeaning: replaceMeaning ? manualMeaningFromImport(importedMeaning!) ?? null : previous?.dictionaryMeaning,
          dictionaryReference: previous?.dictionaryReference,
          phonetics: previous?.phonetics,
          phonetic: candidate.input.phonetic?.trim() ? candidate.input.phonetic : previous?.phonetic,
          meaningSource: replaceMeaning ? 'manual' : previous?.meaningSource,
          meaningNeedsReview: replaceMeaning ? undefined : previous?.meaningNeedsReview,
        }
        const entry = makeEntry(deckId, input, now, previous)
        store.saveEntry(entry)
        if (previous) updated++
        else { added++; newEntries.push(entry.id) }
      }
      const grouping = listSize === undefined ? deck : { ...deck, listSize }
      if (added && grouping.listSize !== deck.listSize) store.saveDeck(revise(grouping, now))
      store.lists.append(grouping, newEntries)
      return { added, updated, skipped }
    },
    exportLibrary(deckId?: string): LibraryExport {
      const decks = deckId ? [requireDeck(deckId, false)] : store.decks()
      const entries = store.entries(deckId)
      const ids = new Set(entries.map(({ id }) => id))
      const practiceEvents = store.all<PracticeEvent>('SELECT body FROM practice_events').filter(({ entryId }) => ids.has(entryId))
      const spellingAttempts = store.all<SpellingAttempt>('SELECT body FROM spelling_attempts').filter(({ entryId }) => ids.has(entryId))
      function historyWords(table: 'practice_events' | 'spelling_attempts', events: { id: string }[]) {
        const included = new Set(events.map(({ id }) => id))
        return (store.db.prepare(`SELECT id, word_id AS wordId FROM ${table}`).all() as WordHistoryLink[])
          .filter(({ id }) => included.has(id))
      }
      const practiceWords = historyWords('practice_events', practiceEvents)
      const spellingWords = historyWords('spelling_attempts', spellingAttempts)
      const allReviewEvents = store.all<ReviewEvent>('SELECT body FROM review_events')
      const externalCards = new Set(allReviewEvents.filter(({ entryId }) => !ids.has(entryId)).map(({ cardId }) => cardId))
      const reviewCards = store.cards().filter(({ id, entryId }) => ids.has(entryId) && !externalCards.has(id))
      const includedCards = new Set(reviewCards.map(({ id }) => id))
      const wordCards = cardLinks(store.db).filter(({ cardId }) => includedCards.has(cardId))
      const reviewEvents = allReviewEvents.filter(({ cardId }) => includedCards.has(cardId))
      const includedWords = new Set([...entries, ...wordCards, ...practiceWords, ...spellingWords].map(({ wordId }) => wordId))
      const words = store.all<Word>('SELECT body FROM words').filter(({ id }) => !deckId || includedWords.has(id))
      const partialProgress = new Map<string, WordProgress>()
      if (deckId) {
        const byEvent = new Map(practiceWords.map(({ id, wordId }) => [id, wordId]))
        for (const event of practiceEvents) {
          if (event.outcome !== 'completed' || event.source === 'free') continue
          const wordId = byEvent.get(event.id)!
          partialProgress.set(wordId, recordWordCompletion(partialProgress.get(wordId), wordId, event.completedAt))
        }
      }
      return {
        format: 'lexyn-library', formatVersion: libraryFormatVersion, exportedAt: new Date().toISOString(),
        metadata: { scope: deckId ? 'deck' : 'library' },
        decks, entries, ...store.lists.export(deckId),
        words, wordProgress: deckId ? [...partialProgress.values()] : store.progress(), wordCards, practiceWords, spellingWords,
        practiceEvents, spellingAttempts,
        learnProgress: store.all<LearnProgress>('SELECT body FROM learn_progress').filter(({ entryId }) => ids.has(entryId)),
        reviewCards, reviewEvents,
        schedulerConfig: config,
        settings: { ...store.settings(), spelling: store.spellingSettings() },
      }
    },
  }
}
