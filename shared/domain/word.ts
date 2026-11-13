import { normalizeTerm } from './library.ts'

export interface Word {
  id: string
  language: string
  normalizedTerm: string
  term: string
  variant: string
  createdAt: number
  updatedAt: number
  revision: number
}

export interface WordProgress {
  wordId: string
  firstCompletedAt: number
  lastPracticedAt: number
  completedCount: number
}

export interface WordCardLink {
  wordId: string
  cardId: string
  direction: 'meaning-to-term'
  active: boolean
}

export interface WordHistoryLink {
  id: string
  wordId: string
}

export function wordKey(term: string, language = 'en') {
  const spelling = term.trim().normalize('NFC')
  return {
    language,
    normalizedTerm: normalizeTerm(spelling),
    // Short all-caps English abbreviations can mean something different from the lowercase word.
    variant: language === 'en' && /^[A-Z]{2,4}$/.test(spelling) ? spelling : '',
  }
}

export function recordWordCompletion(previous: WordProgress | undefined, wordId: string, at: number): WordProgress {
  return {
    wordId,
    firstCompletedAt: Math.min(previous?.firstCompletedAt ?? at, at),
    lastPracticedAt: Math.max(previous?.lastPracticedAt ?? at, at),
    completedCount: (previous?.completedCount ?? 0) + 1,
  }
}
