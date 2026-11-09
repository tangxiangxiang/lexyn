import { describe, expect, test } from 'vitest'
import { compareSpelling, dateKey, isSpellingCorrect, normalizeSpelling } from '../../../shared/domain/learning'

describe('spelling', () => {
  test('ignores case and outer whitespace while preserving meaningful punctuation and spaces', () => {
    expect(isSpellingCorrect('Concurrency', ' concurrency ')).toBe(true)
    expect(isSpellingCorrect('copy-on-write', 'COPY-ON-WRITE')).toBe(true)
    expect(isSpellingCorrect("don't", 'dont')).toBe(false)
    expect(isSpellingCorrect('lock-free', 'lock free')).toBe(false)
  })

  test('normalizes Unicode to NFC', () => {
    expect(normalizeSpelling(' cafe\u0301 ')).toBe('café')
    expect(isSpellingCorrect('café', 'cafe\u0301')).toBe(true)
  })

  test('aligns insertions, deletions, and replacements in feedback', () => {
    expect(compareSpelling('cat', 'cut').map(({ status }) => status)).toEqual(['correct', 'incorrect', 'correct'])
    expect(compareSpelling('cat', 'ct').map(({ status }) => status)).toContain('missing')
    expect(compareSpelling('cat', 'cart').map(({ status }) => status)).toContain('extra')
  })

  test('uses local calendar day for quota aggregation', () => {
    const instant = Date.UTC(2026, 0, 1, 16)
    expect(dateKey(instant, 'Asia/Shanghai')).toBe('2026-01-02')
    expect(dateKey(instant, 'America/Los_Angeles')).toBe('2026-01-01')
  })
})
