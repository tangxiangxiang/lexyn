export type LearnMode = 'copy' | 'dictation'
export type LearnSessionStatus = 'active' | 'paused' | 'completed' | 'abandoned'

export interface PracticeEvent {
  id: string
  deckId: string
  entryId: string
  sessionId: string
  mode: LearnMode
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
  sessionId: string
  deckId: string
  mode: LearnMode
  entryIds: string[]
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

export interface DailyNewWords {
  key: string
  value: number
}

export interface SpellingFeedback {
  actual: string
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
      feedback.push({ actual: right[j], status: 'correct' })
      i++
      j++
      continue
    }
    const cost = rows[i][j]
    if (i < left.length && j < right.length && cost === rows[i + 1][j + 1] + 1) {
      feedback.push({ actual: right[j], status: 'incorrect' })
      i++
      j++
    } else if (i < left.length && cost === rows[i + 1][j] + 1) {
      feedback.push({ actual: left[i], status: 'missing' })
      i++
    } else {
      feedback.push({ actual: right[j], status: 'extra' })
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
