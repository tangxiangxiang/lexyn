import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { dictionaryLimits } from '../../shared/domain/dictionary.ts'
import { parseDictionaryMeaning } from './parse.ts'
import type { DictionaryEntry, DictionaryLookup, DictionaryStatus } from '../../shared/contracts/dictionary.ts'

export const dictionaryPath = (dataDir: string) => join(dataDir, 'dictionaries', 'ecdict.sqlite')
export const lookupKey = (word: string) => word.trim().normalize('NFC').toLowerCase().normalize('NFC')

const lookupLimit = 12
export function createEcdict(dataDir?: string) {
  let db: Database.Database | undefined
  let sourceRevision: string | undefined
  let error: string | undefined
  const path = dataDir ? dictionaryPath(dataDir) : undefined

  function connection() {
    if (db) return db
    if (!path || !existsSync(path)) return
    try {
      const opened = new Database(path, { readonly: true, fileMustExist: true })
      if (opened.pragma('user_version', { simple: true }) !== 1
        || !opened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dictionary_entries'").get()) {
        opened.close()
        error = 'Unsupported dictionary database. Reimport ECDICT.'
        return
      }
      try {
        const revision = opened.prepare("SELECT value FROM dictionary_meta WHERE key = 'sourceCommit'").pluck().get()
        sourceRevision = typeof revision === 'string' && revision.trim() && revision.length <= dictionaryLimits.sourceRevision
          && !/\p{Cc}/u.test(revision) ? revision.trim() : undefined
      } catch { sourceRevision = undefined }
      db = opened
      error = undefined
      return db
    } catch {
      error = 'Could not open ECDICT. Reimport the dictionary.'
      return
    }
  }

  function status(): DictionaryStatus {
    const store = connection()
    if (!store) return { installed: false, wordCount: 0, ...(error ? { error } : {}) }
    try {
      const meta = Object.fromEntries((store.prepare('SELECT key, value FROM dictionary_meta').all() as { key: string; value: string }[])
        .map(({ key, value }) => [key, value]))
      return {
        installed: true,
        wordCount: Number(meta.wordCount || store.prepare('SELECT count(*) FROM dictionary_entries').pluck().get()),
        source: meta.source,
        sourceCommit: meta.sourceCommit,
        csvSha256: meta.csvSha256,
      }
    } catch { return { installed: false, wordCount: 0, error: 'ECDICT metadata is invalid.' } }
  }

  function lookup(term: string): DictionaryLookup {
    const query = term.trim().normalize('NFC')
    if (!query || query.length > 240 || /[\r\n\t\p{Cc}]/u.test(query)) throw new Error('Invalid dictionary query.')
    const rows = connection()?.prepare(
      'SELECT word, phonetic, translation, definition, pos, tag FROM dictionary_entries WHERE lookup_key = ? ORDER BY (word = ?) DESC, word LIMIT ?'
    ).all(lookupKey(query), query, lookupLimit) as DictionaryEntry[] | undefined
    if (!rows?.length) return { query, found: false, match: 'none', entries: [], needsReview: false }
    const exact = rows.filter((row) => row.word === query)
    const entries = (exact.length ? exact : rows).map((row) => ({
      ...row, dictionaryMeaning: parseDictionaryMeaning(row.word, row.translation, sourceRevision),
    }))
    return {
      query, found: true, match: exact.length ? 'exact' : 'casefold',
      entries, needsReview: entries.length !== 1,
    }
  }
  return { status, lookup, close: () => { db?.close(); db = undefined } }
}

export type Ecdict = ReturnType<typeof createEcdict>
