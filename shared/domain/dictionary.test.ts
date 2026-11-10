import { expect, test } from 'vitest'
import { cleanDictionaryReference, cleanPhonetics, hasFinalMeaning, meaningFromSenses } from './dictionary.ts'
import { cleanEntry } from './library.ts'

test('projects the complete ordered meaning, removes repeated definitions, and has no short-meaning limit', () => {
  const long = '完整释义'.repeat(40)
  const senses = [
    { partOfSpeech: 'n.', definitions: [long, '线程', '线程'], source: 'ai' as const },
    { partOfSpeech: 'vt.', definitions: ['穿线'], source: 'ai' as const },
    { partOfSpeech: 'n.', definitions: ['线程', '线索'], source: 'manual' as const },
  ]
  expect(meaningFromSenses(senses)).toBe(`n. ${long}；线程；线索\nvt. 穿线`)
  expect(cleanEntry({ term: 'thread', meaning: '旧短释义', dictionaryMeaning: { senses } }).meaning)
    .toBe(`n. ${long}；线程；线索\nvt. 穿线`)
})

test('ECDICT senses are reference-only until a final AI or manual meaning is saved', () => {
  const raw = { sourceWord: 'file', sourceRevision: 'rev-1', rawTranslation: 'n. 文件',
    senses: [{ partOfSpeech: 'n.', definitions: ['文件'], source: 'ecdict' as const }] }
  expect(hasFinalMeaning(raw)).toBe(false)
  expect(hasFinalMeaning({ ...raw, senses: [...raw.senses, { partOfSpeech: 'n.', definitions: ['文件资料'], source: 'ai' }] })).toBe(true)
})

test('phonetics never infer British or American from unspecified dictionary data', () => {
  expect(cleanPhonetics({ unspecified: '/θred/' })).toEqual({ unspecified: '/θred/' })
  expect(cleanPhonetics({ british: '/θred/' })).toEqual({ british: '/θred/' })
  expect(cleanPhonetics({ american: '/θrɛd/' })).toEqual({ american: '/θrɛd/' })
  expect(cleanDictionaryReference({ sourceWord: 'thread', translation: '线', definition: '', partOfSpeech: 'n.', phonetic: '/θred/' }))
    .toMatchObject({ phonetic: '/θred/' })
})

test('preserves multiline ECDICT reference text for iteration and backup', () => {
  const translation = 'n. 文件, 档案\nvt. 归档'
  expect(() => cleanDictionaryReference({ sourceWord: 'file', sourceRevision: 'rev-1', translation,
    definition: 'a container\nfor data', partOfSpeech: 'n.\nvt.', phonetic: 'faɪl' })).toThrow()
  expect(cleanDictionaryReference({ sourceWord: 'file', sourceRevision: 'rev-1', translation,
    definition: 'a container\nfor data', partOfSpeech: 'n.', phonetic: 'faɪl' })).toMatchObject({ translation,
    definition: 'a container\nfor data', partOfSpeech: 'n.' })
})
