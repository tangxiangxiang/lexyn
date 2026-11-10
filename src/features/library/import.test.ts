import { describe, expect, test } from 'vitest'
import { hasRecallPrompt, normalizeTerm } from '../../../shared/domain/library'
import { MAX_IMPORT_ROWS, manualMeaningFromImport, parseImport, previewImport, suggestMapping } from './import'

describe('vocabulary import', () => {
  test('normalizes case and Unicode without stripping punctuation or internal spaces', () => {
    expect(normalizeTerm("  CAFE\u0301-L'API V2  ")).toBe("café-l'api v2")
    expect(normalizeTerm('state-of-the-art')).not.toBe(normalizeTerm('state of the art'))
    expect(hasRecallPrompt({ meaning: ' ' })).toBe(false)
  })

  test('supports BOM, word lists, mixed tab rows and user-selected TXT mode', () => {
    const words = parseImport('\uFEFFWAL\r\ncopy-on-write\r\nlock-free queue\r\n', 'txt')
    const result = previewImport(words, suggestMapping(words.headers), [])
    expect(result.candidates.map(({ input }) => input.term)).toEqual(['WAL', 'copy-on-write', 'lock-free queue'])
    expect(result.missingMeaning).toBe(3)

    const tab = parseImport('deadlock\t死锁\nWAL\ncache\t缓存\textra', 'txt')
    expect(tab.textMode).toBe('tab')
    const preview = previewImport(tab, suggestMapping(tab.headers), [])
    expect(preview.candidates.map(({ input }) => input)).toEqual([{ term: 'deadlock', meaning: '死锁' }, { term: 'WAL' }])
    expect(preview.invalid).toBe(1)
    const manual = parseImport('deadlock\t死锁', 'txt', 'words')
    expect(previewImport(manual, suggestMapping(manual.headers), []).invalid).toBe(1)
  })

  test('maps CSV columns by index and preserves quoted commas, quotes and newlines', () => {
    const csv = parseImport('\uFEFF释义,Word,Example,IPA,Note\r\n"并发, 并行",Concurrency,"He said ""run"".\r\nAgain.",k,study\r\n', 'csv')
    const result = previewImport(csv, { term: 1, meaning: 0, phonetic: 3 }, [])
    expect(result.candidates[0].input).toEqual({ term: 'Concurrency', meaning: '并发, 并行', phonetic: 'k' })
    expect(suggestMapping(csv.headers)).toEqual({ term: 1, meaning: 0, phonetic: 3 })
    expect(() => previewImport(csv, { term: 1, meaning: 0, example: 2 } as never, [])).toThrow('Only Term, Meaning and Phonetic')
    expect(() => previewImport(csv, { term: 1, meaning: 1 }, [])).toThrow('different source column')
    expect(suggestMapping(['Word', '释义', 'IPA'])).toEqual({ term: 0, meaning: 1, phonetic: 2 })
  })

  test('allows an unmapped CSV meaning and distinguishes it from an explicit blank', () => {
    const noMeaning = parseImport('word,example,note\nthread,Old sentence,Keep this note\n', 'csv')
    const unmapped = previewImport(noMeaning, suggestMapping(noMeaning.headers), [])
    expect(unmapped.candidates[0].input).toEqual({ term: 'thread' })
    expect(unmapped.missingMeaning).toBe(1)

    const blankMeaning = parseImport('word,meaning\nthread,\n', 'csv')
    expect(previewImport(blankMeaning, suggestMapping(blankMeaning.headers), []).candidates[0].input)
      .toEqual({ term: 'thread', meaning: '' })
  })

  test('represents imported prose as an unlabelled manual sense only when lossless', () => {
    expect(manualMeaningFromImport('线程；线索')).toEqual({
      senses: [{ partOfSpeech: '', definitions: ['线程；线索'], source: 'manual' }],
    })
    expect(manualMeaningFromImport('first line\nsecond line')).toBeUndefined()
    expect(manualMeaningFromImport('x'.repeat(1001))).toBeUndefined()
  })

  test('rejects malformed or oversized files and reports invalid individual records', () => {
    expect(() => parseImport('term,meaning\nvalid,有效\n"broken,无效', 'csv')).toThrow('Invalid CSV')
    const csv = parseImport('term,meaning\n,缺少英文\nextra,释义,column\nWAL,', 'csv')
    expect(previewImport(csv, suggestMapping(csv.headers), [])).toMatchObject({ invalid: 2, valid: 1, missingMeaning: 1 })
    expect(() => parseImport('x\n'.repeat(MAX_IMPORT_ROWS + 1), 'txt')).toThrow('10,000')
    expect(() => parseImport('term,meaning\n' + 'x,y\n'.repeat(MAX_IMPORT_ROWS + 1), 'csv')).toThrow('10,000')
    expect(() => parseImport('x'.repeat(5 * 1024 * 1024 + 1), 'txt')).toThrow('5 MiB')
  })
})
