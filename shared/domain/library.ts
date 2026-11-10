interface LocalEntity {
  id: string
  createdAt: number
  updatedAt: number
  revision: number
}

export interface DeckInput {
  name: string
  description?: string
}

export interface Deck extends LocalEntity, DeckInput {
  archivedAt?: number
}

export interface EntryInput {
  term: string
  meaning: string
  meaningSource?: 'manual' | 'ai' | 'dictionary'
  meaningNeedsReview?: boolean
  phonetic?: string
  explanation?: string
  pronunciationOverride?: string
  example?: string
  note?: string
}

export interface Entry extends LocalEntity, EntryInput {
  deckId: string
  normalizedTerm: string
  deletedAt?: number
  termChangedAt?: number
}

export const entryLimits = { term: 240, meaning: 2000, explanation: 200, phonetic: 240, pronunciationOverride: 240, example: 4000, note: 4000 }

export function normalizeTerm(term: string) {
  return term.trim().normalize('NFC').toLowerCase().normalize('NFC')
}

export function hasRecallPrompt(entry: Pick<Entry, 'meaning'>) {
  return entry.meaning.trim().length > 0
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
  return { name, description: clean(input.description, 1000, 'Description') || undefined }
}

export function cleanEntry(input: EntryInput): EntryInput {
  const term = clean(input.term, entryLimits.term, 'Term')
  if (!term) throw new LibraryError('Enter a term.')
  if (/[\r\n\t]/.test(term)) throw new LibraryError('A term must fit on one line and contain no tabs.')
  const pronunciationOverride = clean(input.pronunciationOverride, entryLimits.pronunciationOverride, 'Pronunciation override')
  if (/[\r\n\t]|<#/.test(pronunciationOverride)) throw new LibraryError('Use a single line of pronunciation text without pause markers.')
  return {
    term,
    meaning: clean(input.meaning, entryLimits.meaning, 'Meaning'),
    explanation: clean(input.explanation, entryLimits.explanation, 'Explanation') || undefined,
    phonetic: clean(input.phonetic, entryLimits.phonetic, 'Phonetic') || undefined,
    pronunciationOverride: pronunciationOverride || undefined,
    example: clean(input.example, entryLimits.example, 'Example') || undefined,
    note: clean(input.note, entryLimits.note, 'Note') || undefined,
  }
}
