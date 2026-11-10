import { randomUUID } from 'node:crypto'
import { hasFinalMeaning } from '../../shared/domain/dictionary.ts'
import { libraryFormatVersion, type LibraryExport } from '../../shared/contracts/library.ts'
import { stableJson } from '../../shared/contracts/json.ts'
import { cleanDeck, cleanEntry, normalizeTerm, type Deck, type DeckInput, type Entry, type EntryInput } from '../../shared/domain/library.ts'
import type { LearnProgress, PracticeEvent } from '../../shared/domain/learning.ts'
import type { ReviewEvent, ReviewSchedulerConfig } from '../../shared/domain/review.ts'
import { manualMeaningFromImport, type DuplicateMode, type ImportPreview } from '../../shared/domain/library-import.ts'
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
    const sameTerm = previous !== undefined && normalizeTerm(previous.term) === normalizeTerm(input.term)
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
      termChangedAt: previous && previous.normalizedTerm !== normalizedTerm ? now : previous?.termChangedAt,
    }
  }

  return {
    listDecks(offset: number, limit: number) {
      const summaries = new Map(store.decks().map((deck) => [deck.id, { deck, count: 0, modifiedAt: deck.updatedAt }]))
      for (const entry of store.entries()) {
        const summary = summaries.get(entry.deckId)!
        if (entry.deletedAt === undefined) summary.count++
        summary.modifiedAt = Math.max(summary.modifiedAt, entry.updatedAt)
      }
      return [...summaries.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.deck.id.localeCompare(b.deck.id))
        .slice(offset, offset + limit)
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
      store.saveDeck({ ...revise(deck, now), ...cleanDeck(input) })
    },
    setDeckArchived(id: string, archived: boolean, revision: number, now: number) {
      const deck = requireDeck(id, false)
      checkRevision(deck, revision)
      if ((deck.archivedAt !== undefined) === archived) return
      store.saveDeck({ ...revise(deck, now), archivedAt: archived ? now : undefined })
      const learn = store.openLearn()
      if (archived && learn?.deckId === id && learn.status === 'active') {
        store.saveLearn({ ...learn, status: 'paused', updatedAt: now })
      }
    },
    createEntry(deckId: string, input: EntryInput, now: number) {
      requireDeck(deckId)
      const entry = makeEntry(deckId, input, now)
      unique(deckId, entry.normalizedTerm)
      store.saveEntry(entry)
      return entry
    },
    updateEntry(deckId: string, id: string, input: EntryInput, revision: number, now: number) {
      const previous = requireEntry(deckId, id)
      checkRevision(previous, revision)
      if (previous.deletedAt !== undefined) throw new StudyError('Restore this word before editing it.', 409)
      const entry = makeEntry(deckId, { ...input, explanation: input.explanation ?? previous.explanation }, now, previous)
      unique(deckId, entry.normalizedTerm, id)
      store.saveEntry(entry)
      return entry
    },
    setEntryRemoved(deckId: string, id: string, removed: boolean, revision: number, now: number) {
      const entry = requireEntry(deckId, id)
      checkRevision(entry, revision)
      if ((entry.deletedAt !== undefined) === removed) return
      if (!removed) unique(deckId, entry.normalizedTerm, id)
      store.saveEntry({ ...revise(entry, now), deletedAt: removed ? now : undefined })
    },
    importEntries(deckId: string, candidates: ImportPreview['candidates'], mode: DuplicateMode, now: number) {
      requireDeck(deckId)
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
        store.saveEntry(makeEntry(deckId, input, now, previous))
        if (previous) updated++
        else added++
      }
      return { added, updated, skipped }
    },
    exportLibrary(deckId?: string): LibraryExport {
      const decks = deckId ? [requireDeck(deckId, false)] : store.decks()
      const entries = store.entries(deckId)
      const ids = new Set(entries.map(({ id }) => id))
      return {
        format: 'lexyn-library', formatVersion: libraryFormatVersion, exportedAt: new Date().toISOString(),
        metadata: { scope: deckId ? 'deck' : 'library' },
        decks, entries,
        practiceEvents: store.all<PracticeEvent>('SELECT body FROM practice_events').filter(({ entryId }) => ids.has(entryId)),
        learnProgress: store.all<LearnProgress>('SELECT body FROM learn_progress').filter(({ entryId }) => ids.has(entryId)),
        reviewCards: store.cards().filter(({ entryId }) => ids.has(entryId)),
        reviewEvents: store.all<ReviewEvent>('SELECT body FROM review_events').filter(({ entryId }) => ids.has(entryId)),
        schedulerConfig: config,
        settings: store.settings(),
      }
    },
  }
}
