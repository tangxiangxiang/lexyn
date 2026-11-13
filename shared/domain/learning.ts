import type { KeyboardLayout, PracticeSource, SpellingHint, SpellingPreferences } from './spelling.ts'

export type LearnMode = 'copy' | 'dictation'
export type LearnSessionStatus = 'active' | 'paused' | 'completed' | 'abandoned'

export interface PracticeEvent {
  id: string
  deckId: string
  listId?: string
  entryId: string
  sessionId: string
  mode: LearnMode
  source?: PracticeSource
  round?: number
  outcome: 'completed' | 'skipped'
  attempts: number
  firstTryCorrect: boolean
  assisted: boolean
  startedAt: number
  completedAt: number
}

export interface LearnProgress {
  entryId: string
  firstCompletedAt?: number
  lastPracticedAt: number
  completedCount: number
}

export interface LearnSession {
  studyFlowId?: string
  source?: PracticeSource
  spelling?: SpellingPreferences
  currentKeyboard?: KeyboardLayout
  currentHints?: SpellingHint[]
  currentCorrectSpelling?: { term: string; changedAt?: number }
  listId?: string
  sessionId: string
  deckId: string
  mode: LearnMode
  entryIds: string[]
  entryWords?: Record<string, string | null>
  currentIndex: number
  startedAt: number
  updatedAt: number
  status: LearnSessionStatus
  dailyKey: string
  firstCompletedEntryIds: string[]
  currentEntryStartedAt: number
  currentAttempts: number
  currentFirstTryCorrect?: boolean
  currentAssisted: boolean
  currentLastSubmitted?: string
  ttsVoicesAvailable?: boolean
}

export function practiceRound(session: LearnSession) {
  const id = session.entryIds[session.currentIndex]
  return session.entryIds.slice(0, session.currentIndex).filter((candidate) => candidate === id).length
}

export function hasCorrectSpelling(session: LearnSession, term: string, changedAt?: number) {
  if (session.currentCorrectSpelling) return session.currentCorrectSpelling.term === normalizeSpelling(term)
    && session.currentCorrectSpelling.changedAt === changedAt
  return !!session.currentLastSubmitted && isSpellingCorrect(term, session.currentLastSubmitted)
}

export interface SpellingFeedback {
  actual: string
  position: number
  status: 'correct' | 'incorrect' | 'missing' | 'extra'
}

export function normalizeSpelling(value: string) {
  return value.trim().normalize('NFC').toLowerCase().normalize('NFC')
}

export function isSpellingCorrect(expected: string, actual: string) {
  return normalizeSpelling(expected) === normalizeSpelling(actual)
}

/** Returns a short edit-aligned diff so insertions and deletions do not shift every later character. */
export function compareSpelling(expected: string, actual: string): SpellingFeedback[] {
  const left = [...expected.normalize('NFC')]
  const right = [...actual.normalize('NFC')]
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let i = left.length; i >= 0; i--) {
    for (let j = right.length; j >= 0; j--) {
      if (i === left.length) rows[i][j] = right.length - j
      else if (j === right.length) rows[i][j] = left.length - i
      else if (left[i].toLowerCase() === right[j].toLowerCase()) rows[i][j] = rows[i + 1][j + 1]
      else rows[i][j] = Math.min(rows[i + 1][j + 1] + 1, rows[i + 1][j] + 1, rows[i][j + 1] + 1)
    }
  }

  const feedback: SpellingFeedback[] = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length
      && left[i].toLowerCase() === right[j].toLowerCase()
      && rows[i][j] === rows[i + 1][j + 1]) {
      feedback.push({ actual: right[j], status: 'correct', position: i })
      i++
      j++
      continue
    }
    const cost = rows[i][j]
    if (i < left.length && j < right.length && cost === rows[i + 1][j + 1] + 1) {
      feedback.push({ actual: right[j], status: 'incorrect', position: i })
      i++
      j++
    } else if (i < left.length && cost === rows[i + 1][j] + 1) {
      feedback.push({ actual: left[i], status: 'missing', position: i })
      i++
    } else {
      feedback.push({ actual: right[j], status: 'extra', position: i })
      j++
    }
  }
  return feedback
}

export function dateKey(time: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(time)
  const part = (type: string) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
