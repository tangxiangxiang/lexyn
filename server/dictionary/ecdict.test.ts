import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createEcdict } from './ecdict.ts'
import { importEcdictCsv } from './import.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
test('streams quoted multiline ECDICT data into independent readonly SQLite and preserves existing dictionary on invalid CSV', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lexyn-ecdict-'))
  dirs.push(dir)
  const csv = join(dir, 'sample.csv')
  writeFileSync(csv,
    'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n' +
    'queue,kjuː,,n. 队列,n.,,,,,,,,\n' +
    'thread,θred,,"n. 线程；线索\nv. 穿过",n.,,,,,,,,\n' +
    'US,juː ɛs,,美国,abbr.,,,,,,,,\n' +
    'us,əs,,我们,pron.,,,,,,,,\n')
  const imported = await importEcdictCsv(dir, csv, 'test-source')
  expect(imported.count).toBe(4)
  const dictionary = createEcdict(dir)
  expect(dictionary.status()).toMatchObject({ installed: true, wordCount: 4, sourceCommit: 'test-source' })
  expect(dictionary.lookup('queue')).toMatchObject({ found: true, needsReview: false, entries: [{ translation: 'n. 队列' }] })
  expect(dictionary.lookup('thread')).toMatchObject({ found: true })
  expect(dictionary.lookup('thread').entries[0]?.translation).toContain('线程；线索')
  expect(dictionary.lookup('thread').entries[0]?.translation).toContain('穿过')
  expect(dictionary.lookup('US')).toMatchObject({ found: true, entries: [{ translation: '美国' }] })
  expect(dictionary.lookup('us')).toMatchObject({ found: true, entries: [{ translation: '我们' }] })
  expect(dictionary.lookup('absent').found).toBe(false)
  dictionary.close()
  writeFileSync(csv, 'invalid,header\nword,data\n')
  await expect(importEcdictCsv(dir, csv)).rejects.toThrow()
  expect(createEcdict(dir).lookup('queue').entries[0]?.translation).toBe('n. 队列')
})
test('missing dictionary is nonfatal', () => {
  const dict = createEcdict()
  expect(dict.status()).toEqual({ installed: false, wordCount: 0 })
  expect(dict.lookup('thread')).toMatchObject({ found: false, needsReview: false })
})
