import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import Papa from 'papaparse'
import { entryLimits } from '../../shared/domain/library.ts'
import { wordKey } from '../../shared/domain/word.ts'
import { cefrLevels, type VocabularySource } from '../../shared/contracts/wordbooks.ts'

export const classificationPath = (dataDir: string) => join(dataDir, 'dictionaries', 'classification.sqlite')
const repository = 'https://github.com/openlanguageprofiles/olp-en-cefrj'
export const cefrSources = {
  'cefr-j': { name: 'CEFR-J Vocabulary Profile', url: repository + '/blob/master/cefrj-vocabulary-profile-1.5.csv',
    license: 'CEFR-J terms of use (attribution required)', redistribution: 'not-verified', levels: cefrLevels.slice(0, 4) },
  octanove: { name: 'Octanove Vocabulary Profile', url: repository + '/blob/master/octanove-vocabulary-profile-c1c2-1.0.csv',
    license: 'CC BY-SA 4.0', redistribution: 'with-attribution-and-share-alike', levels: cefrLevels.slice(4) },
} as const

export function importCefr(dataDir: string, csvPath: string, sourceId: keyof typeof cefrSources, version: string) {
  if (!Object.hasOwn(cefrSources, sourceId) || !/^[\w.-]{1,128}$/.test(version)) throw new Error('Invalid CEFR source or version.')
  const { levels, ...source } = cefrSources[sourceId]
  const csv = readFileSync(csvPath)
  const parsed = Papa.parse<{ headword: string; CEFR: string }>(new TextDecoder('utf-8', { fatal: true }).decode(csv),
    { header: true, skipEmptyLines: 'greedy' })
  if (parsed.errors.length || !['headword', 'CEFR'].every((field) => parsed.meta.fields?.includes(field))) {
    throw new Error('Invalid CEFR CSV.')
  }
  const path = classificationPath(dataDir)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp'
  let db: Database.Database | undefined
  try {
    if (existsSync(path)) copyFileSync(path, temporary)
    const target = db = new Database(temporary)
    target.pragma('foreign_keys = ON')
    target.exec(`
      CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, version TEXT NOT NULL, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS levels (source TEXT NOT NULL REFERENCES sources(name),
        normalized_term TEXT NOT NULL, variant TEXT NOT NULL, level TEXT NOT NULL,
        PRIMARY KEY(normalized_term, variant, source, level)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS classification_by_source ON levels(source);
    `)
    const metadata = target.transaction(() => {
      target.prepare('DELETE FROM levels WHERE source=?').run(source.name)
      target.prepare('INSERT INTO sources VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET version=excluded.version, body=excluded.body')
        .run(source.name, version, '{}')
      const insert = target.prepare('INSERT OR IGNORE INTO levels VALUES (?, ?, ?, ?)')
      for (const row of parsed.data) {
        if (!levels.some((level) => level === row.CEFR) || typeof row.headword !== 'string') {
          throw new Error('Invalid CEFR CSV record.')
        }
        for (const term of row.headword.split('/').map((part) => part.trim())) {
          if (!term || term.length > entryLimits.term || /\p{Cc}/u.test(term)) continue
          const { normalizedTerm, variant } = wordKey(term)
          insert.run(source.name, normalizedTerm, variant, row.CEFR)
        }
      }
      const wordCount = target.prepare(`
        SELECT count(*) FROM (SELECT DISTINCT normalized_term, variant FROM levels WHERE source=?)
      `).pluck().get(source.name) as number
      if (!wordCount) throw new Error('CEFR CSV contains no valid headwords.')
      const record: VocabularySource = { ...source, version, importedAt: new Date().toISOString(),
        sha256: createHash('sha256').update(csv).digest('hex'), fields: ['cefr'], wordCount }
      target.prepare('UPDATE sources SET body=? WHERE name=?').run(JSON.stringify(record), source.name)
      return record
    })()
    if (target.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('CEFR SQLite integrity check failed.')
    target.close()
    db = undefined
    renameSync(temporary, path)
    return metadata
  } finally {
    db?.close()
    rmSync(temporary, { force: true })
  }
}
