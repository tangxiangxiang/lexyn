import { expect, test } from 'vitest'
import { compareSpelling, isSpellingCorrect } from './learning.ts'
import { spellingErrors, spellingKeyboard, spellingStats, type SpellingAttempt } from './spelling.ts'
import { spellingSyllables } from './spelling-syllables.ts'

test.each(['apple', 'letter', 'bookkeeper', 'information', 'internationalization', 'copy-on-write', "don't", 'ice cream', 'HTTP'])(
  'offers every character in %s once, with letters in QWERTY order', (word) => {
    const keyboard = spellingKeyboard(word, 'simplified', true)
    const allKeys = keyboard.rows.flat().concat(keyboard.symbols, keyboard.space ? [' '] : [])
    expect(new Set(allKeys)).toEqual(new Set(word.toLowerCase()))
    expect(allKeys).toHaveLength(new Set(word.toLowerCase()).size)
    expect(keyboard.rows.flat().join('')).toBe([...'qwertyuiopasdfghjklzxcvbnm'].filter((key) => word.toLowerCase().includes(key)).join(''))
  },
)

test('uses generic keys for hidden dictation and falls back for unsupported spelling', () => {
  expect(spellingKeyboard('apple', 'simplified', false)).toEqual(spellingKeyboard('let-ter', 'full', false))
  expect(spellingKeyboard('café', 'simplified', true)).toMatchObject({ layout: 'full', symbols: ['é'] })
  expect(isSpellingCorrect('Éclair', 'e\u0301clair')).toBe(true)
  expect(isSpellingCorrect('HTTP', 'Http')).toBe(true)
})

test('aligns repeated, omitted and extra letters without shifting later positions', () => {
  expect(spellingErrors('letter', 'leter')).toEqual([{ type: 'missing', expected: 't', position: 3 }])
  expect(spellingErrors('letter', 'lettter')).toEqual([{ type: 'extra', expected: 'e', position: 4 }])
  expect(spellingErrors('letter', 'leyter')).toEqual([{ type: 'incorrect', expected: 't', position: 2 }])
  expect(spellingErrors('letter', 'lex', true)).toEqual([{ type: 'incorrect', expected: 't', position: 2 }])
  expect(compareSpelling('bookkeeper', 'bookkeper').filter(({ status }) => status !== 'correct')).toHaveLength(1)
})

test('uses the reviewed spelling boundaries and preserves casing without guessing', () => {
  expect(spellingSyllables('INFORMATION')).toEqual(['IN', 'FOR', 'MA', 'TION'])
  expect(spellingSyllables('bookkeeper')?.join('')).toBe('bookkeeper')
  expect(spellingSyllables('internationalization')?.join('')).toBe('internationalization')
  expect(spellingSyllables('copy-on-write')).toBeUndefined()
  expect(spellingSyllables("don't")).toBeUndefined()
  expect(spellingSyllables('ice cream')).toBeUndefined()
})

test('aggregates separate occurrences and excludes old spelling versions from position counts', () => {
  const row: SpellingAttempt = { id: 'a', entryId: 'e', sessionId: 's', round: 0, attempt: 1,
    spelling: 'letter', time: 1, source: 'learn', mode: 'copy', keyboard: 'full',
    assisted: false, correct: false, errors: spellingErrors('letter', 'leyter') }
  const history = [row, { ...row, id: 'b', time: 2, termChangedAt: 2, errors: spellingErrors('letter', 'leter') }]
  expect(spellingStats(history, 'letter', 2)).toMatchObject({ attempts: 2, failures: 2, currentAttempts: 1, latest: 2,
    positions: [{ position: 3, expected: 't', count: 1 }] })
  expect(spellingStats(history, 'letters').positions).toEqual([])
})
