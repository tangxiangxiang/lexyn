import { cleanDictionaryMeaning, cleanDictionaryReference, cleanPhonetics, hasFinalMeaning, meaningFromSenses,
  type DictionaryMeaning, type DictionaryReference, type PhoneticVariants } from './dictionary.ts'

interface LocalEntity {
  id: string
  createdAt: number
  updatedAt: number
  revision: number
}

export interface DeckInput {
  name: string
  description?: string
  listSize?: number
}

export interface Deck extends LocalEntity, DeckInput {
  archivedAt?: number
}

export const listSizes = { min: 1, default: 30, max: 100 } as const

export interface DeckList {
  id: string
  deckId: string
  name: string
  order: number
}

export interface DeckListMember {
  entryId: string
  listId: string
  position: number
}

export interface DeckListSummary extends DeckList {
  count: number
  learned: number
}

export interface EntryInput {
  term: string
  meaning: string
  dictionaryMeaning?: DictionaryMeaning | null
  dictionaryReference?: DictionaryReference | null
  phonetics?: PhoneticVariants | null
  meaningSource?: 'manual' | 'ai' | 'dictionary'
  meaningNeedsReview?: boolean
  phonetic?: string
  explanation?: string
  pronunciationOverride?: string
  example?: string
  note?: string
}

export interface Entry extends LocalEntity, Omit<EntryInput, 'dictionaryMeaning' | 'dictionaryReference' | 'phonetics'> {
  deckId: string
  /** Present in server records and v8 backups. Older imports acquire it at restore. */
  wordId?: string
  dictionaryMeaning?: DictionaryMeaning
  dictionaryReference?: DictionaryReference
  phonetics?: PhoneticVariants
  /** A manual clear suppresses automatic pronunciation updates until IPA is supplied again. */
  phoneticsCleared?: boolean
  phoneticsNeedsReview?: boolean
  normalizedTerm: string
  deletedAt?: number
  termChangedAt?: number
}

export const entryLimits = { term: 240, meaning: 40_000, explanation: 200, phonetic: 240, pronunciationOverride: 240, example: 4000, note: 4000 }

export function normalizeTerm(term: string) {
  return term.trim().normalize('NFC').toLowerCase().normalize('NFC')
}

export function hasRecallPrompt(entry: Pick<Entry, 'meaning'> & Partial<Pick<Entry, 'dictionaryMeaning'>>) {
  return hasFinalMeaning(entry.dictionaryMeaning) || entry.meaning.trim().length > 0
}

export class LibraryError extends Error {}

function clean(value: string | undefined, limit: number, label: string) {
  const text = value?.trim() ?? ''
  if (text.length > limit) throw new LibraryError(`${label} must be at most ${limit} characters.`)
  return text
}

export function cleanDeck(input: DeckInput): DeckInput {
  const name = clean(input.name, 100, 'Deck name')
  if (!name) throw new LibraryError('Enter a deck name.')
  return { name, description: clean(input.description, 1000, 'Description') || undefined, listSize: input.listSize }
}

export function cleanEntry(input: EntryInput): Omit<EntryInput, 'dictionaryMeaning' | 'dictionaryReference' | 'phonetics'>
  & { dictionaryMeaning?: DictionaryMeaning; dictionaryReference?: DictionaryReference; phonetics?: PhoneticVariants } {
  const term = clean(input.term, entryLimits.term, 'Term')
  if (!term) throw new LibraryError('Enter a term.')
  if (/[\r\n\t]/.test(term)) throw new LibraryError('A term must fit on one line and contain no tabs.')
  const pronunciationOverride = clean(input.pronunciationOverride, entryLimits.pronunciationOverride, 'Pronunciation override')
  if (/[\r\n\t]|<#/.test(pronunciationOverride)) throw new LibraryError('Use a single line of pronunciation text without pause markers.')
  let dictionaryMeaning: DictionaryMeaning | undefined
  try { dictionaryMeaning = cleanDictionaryMeaning(input.dictionaryMeaning) }
  catch { throw new LibraryError('Invalid dictionary meaning.') }
  if (dictionaryMeaning?.sourceWord && normalizeTerm(dictionaryMeaning.sourceWord) !== normalizeTerm(term)) {
    throw new LibraryError('Dictionary meaning belongs to another word.')
  }
  let dictionaryReference: DictionaryReference | undefined
  try { dictionaryReference = cleanDictionaryReference(input.dictionaryReference) }
  catch { throw new LibraryError('Invalid dictionary reference.') }
  if (dictionaryReference && normalizeTerm(dictionaryReference.sourceWord) !== normalizeTerm(term)) {
    throw new LibraryError('Dictionary reference belongs to another word.')
  }
  let phonetics: PhoneticVariants | undefined
  try { phonetics = cleanPhonetics(input.phonetics) }
  catch { throw new LibraryError('Invalid phonetics.') }
  const meaning = hasFinalMeaning(dictionaryMeaning) ? meaningFromSenses(dictionaryMeaning!.senses) : clean(input.meaning, entryLimits.meaning, 'Meaning')
  if (meaning.length > entryLimits.meaning) throw new LibraryError(`Meaning must be at most ${entryLimits.meaning} characters.`)
  return {
    term,
    dictionaryMeaning,
    dictionaryReference,
    phonetics,
    meaning,
    explanation: clean(input.explanation, entryLimits.explanation, 'Explanation') || undefined,
    phonetic: clean(input.phonetic, entryLimits.phonetic, 'Phonetic') || undefined,
    pronunciationOverride: pronunciationOverride || undefined,
    example: clean(input.example, entryLimits.example, 'Example') || undefined,
    note: clean(input.note, entryLimits.note, 'Note') || undefined,
  }
}
