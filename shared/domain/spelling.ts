import { compareSpelling, normalizeSpelling } from './learning.ts'

export type KeyboardLayout = 'full' | 'simplified'
export type SpellingHint = 'keyboard' | 'syllables' | 'reveal'
export type PracticeSource = 'learn' | 'free'

export interface SpellingPreferences {
  keyboard: KeyboardLayout
  syllables: boolean
  strict: boolean
  retryLimit: number
  speakLetters: boolean
}

export const defaultSpelling: Readonly<SpellingPreferences> = {
  keyboard: 'full', syllables: false, strict: true, retryLimit: 0, speakLetters: false,
}

export interface SpellingError {
  position: number
  expected: string
  type: 'incorrect' | 'missing' | 'extra'
}

export interface SpellingAttempt {
  id: string
  entryId: string
  sessionId: string
  round: number
  attempt: number
  spelling: string
  termChangedAt?: number
  time: number
  source: PracticeSource
  mode: 'copy' | 'dictation'
  keyboard: KeyboardLayout
  assisted: boolean
  correct: boolean
  errors: SpellingError[]
}

export function spellingErrors(expected: string, input: string, partial = false): SpellingError[] {
  const term = normalizeSpelling(expected)
  const answer = partial ? input.normalize('NFC').toLowerCase().normalize('NFC') : normalizeSpelling(input)
  const letters = [...term]
  // Strict copy stops at the first bad prefix. Letters the user has not
  // reached are not omissions. Explicit submissions use the full alignment.
  const target = partial ? letters.slice(0, [...answer].length).join('') : term
  return compareSpelling(target, answer).flatMap(({ status, position }) =>
    status === 'correct' ? [] : [{ type: status, position, expected: letters[position] ?? '' }])
}

const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const punctuation = "0123456789-’'.,!?&/+():;_"

export function spellingKeyboard(term: string, requested: KeyboardLayout, visible: boolean) {
  const letters = [...new Set(normalizeSpelling(term))]
  const simplified = requested === 'simplified' && visible && letters.some((key) => /^[a-z]$/.test(key))
    && letters.every((key) => /^[a-z ]$/.test(key) || punctuation.includes(key))
  return {
    layout: (simplified ? 'simplified' : 'full') as KeyboardLayout,
    rows: rows.map((row) => [...row].filter((key) => !simplified || letters.includes(key))).filter((row) => row.length),
    symbols: visible ? letters.filter((key) => !/^[a-z\s]$/.test(key)) : [...punctuation],
    space: !visible || letters.includes(' '),
  }
}

export function spellingStats(rows: SpellingAttempt[], term: string, termChangedAt?: number) {
  const spelling = normalizeSpelling(term)
  const current = rows.filter((row) => row.spelling === spelling && row.termChangedAt === termChangedAt)
  const positions = new Map<number, { position: number; expected: string; count: number; errors: Record<SpellingError['type'], number> }>()
  for (const row of current) {
    for (const error of row.errors) {
      const position = positions.get(error.position) ?? { position: error.position, expected: error.expected,
        count: 0, errors: { incorrect: 0, missing: 0, extra: 0 } }
      position.count++
      position.errors[error.type]++
      positions.set(error.position, position)
    }
  }
  return {
    attempts: rows.length,
    failures: rows.filter((row) => !row.correct).length,
    firstCorrect: rows.filter((row) => row.correct && row.attempt === 1 && row.round === 0 && !row.assisted).length,
    latest: rows.reduce<number | undefined>((latest, row) => Math.max(latest ?? 0, row.time), undefined),
    currentAttempts: current.length,
    positions: [...positions.values()].sort((a, b) => a.position - b.position),
  }
}
