import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { DictionaryEntry, DictionaryLookup, DictionaryStatus } from '../../shared/contracts/dictionary.ts'

export const dictionaryPath = (dataDir: string) => join(dataDir, 'dictionaries', 'ecdict.sqlite')
export const lookupKey = (word: string) => word.trim().normalize('NFC').toLowerCase().normalize('NFC')

const lookupLimit = 12
const header = /^(?:n|v|vt|vi|adj|adv|a|prep|pron|conj|int|num|abbr|aux)\.\s*/i

/** Never truncate arbitrary multi-sense dictionary content into a misleading review prompt. */
export function suggestedMeaning(lookup: DictionaryLookup): string | undefined {
  if (!lookup.found || lookup.entries.length !== 1) return
  if (lookup.match === 'casefold' && /[A-Z]/.test(lookup.query)) return
  const lines = lookup.entries[0].translation.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 1) return
  const line = lines[0]
  if (/\[(?:网络|网络释义|人名)\]/.test(line) || /[；;]/.test(line) || /^</.test(line)) return
  const text = line.replace(header, '').replace(/^\[(?:计|医|法|经|化)\]\s*/, '').trim()
  if (!text || text.length > 80 || /[<>\r\n]/.test(text) || !/\p{Script=Han}/u.test(text)) return
  return text
}

export function createEcdict(dataDir?: string) {
  let db: Database.Database | undefined
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
      'SELECT word, phonetic, translation, definition, pos, tag FROM dictionary_entries WHERE lookup_key = ? LIMIT ?'
    ).all(lookupKey(query), lookupLimit) as DictionaryEntry[] | undefined
    if (!rows?.length) return { query, found: false, match: 'none', entries: [], needsReview: false }
    const exact = rows.filter((row) => row.word === query)
    const entries = exact.length ? exact : rows
    const result: DictionaryLookup = {
      query, found: true, match: exact.length ? 'exact' : 'casefold',
      entries, needsReview: entries.length !== 1,
    }
    const meaning = suggestedMeaning(result)
    return { ...result, suggestedMeaning: meaning, needsReview: result.needsReview || !meaning }
  }
  return { status, lookup, close: () => { db?.close(); db = undefined } }
}

export type Ecdict = ReturnType<typeof createEcdict>
