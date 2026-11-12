import { normalizeSpelling } from './learning.ts'

// Written mnemonic chunks checked against each headword at
// https://www.merriam-webster.com/dictionary/<word>. No guessed boundaries.
const reviewed = new Map([
  ['apple', [2, 3]],
  ['bookkeeper', [4, 4, 2]],
  ['computer', [3, 3, 2]],
  ['information', [2, 3, 2, 4]],
  ['internationalization', [2, 3, 2, 4, 2, 3, 4]],
  ['letter', [3, 3]],
])

export function spellingSyllables(term: string): string[] | undefined {
  const sizes = reviewed.get(normalizeSpelling(term))
  const letters = [...term.normalize('NFC')]
  if (!sizes || sizes.reduce((total, size) => total + size, 0) !== letters.length) return
  let start = 0
  return sizes.map((size) => {
    const chunk = letters.slice(start, start + size).join('')
    start += size
    return chunk
  })
}
