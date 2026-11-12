import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { dictionaryLimits } from '../../shared/domain/dictionary.ts'
import { builtinWordbooks, builtinWordbookTags, type BuiltinWordbookId, type BuiltinWordbookTag } from '../../shared/domain/builtin-books.ts'
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

  function wordbooks() {
    const store = connection()
    return {
      installed: !!store,
      books: builtinWordbooks.map(({ id, name, tag }) => {
        const count = store && tag
          ? Number(store.prepare(`SELECT count(DISTINCT lookup_key) FROM dictionary_entries
            WHERE instr(' ' || lower(tag) || ' ', ?) > 0 AND trim(translation) <> ''`).pluck().get(` ${tag} `))
          : 0
        return { id, name, count, available: !!store && !!tag && count > 0 }
      }),
    }
  }

  function wordbookDetail(bookId: BuiltinWordbookId, selectedTags: BuiltinWordbookTag[] = builtinWordbookTags.map(({ id }) => id)) {
    const book = builtinWordbooks.find(({ id }) => id === bookId)
    const store = connection()
    const countForTags = (tags: BuiltinWordbookTag[]) => {
      if (!store || !book?.tag || !tags.length) return 0
      const matching = tags.map(() => "instr(' ' || lower(tag) || ' ', ?) > 0").join(' OR ')
      return Number(store.prepare(`SELECT count(DISTINCT lookup_key) FROM dictionary_entries
        WHERE instr(' ' || lower(tag) || ' ', ?) > 0 AND trim(translation) <> '' AND (${matching})`)
        .pluck().get(` ${book.tag} `, ...tags.map((tag) => ` ${tag} `)))
    }
    return {
      installed: !!store,
      count: countForTags(selectedTags),
      categories: builtinWordbookTags.map(({ id, name }) => ({ id, name, count: countForTags([id]), selected: selectedTags.includes(id) })),
    }
  }

  function wordbookEntries(bookId: BuiltinWordbookId, selectedTags: BuiltinWordbookTag[] = builtinWordbookTags.map(({ id }) => id)): DictionaryEntry[] | undefined {
    const book = builtinWordbooks.find(({ id }) => id === bookId)
    if (!book?.tag) return []
    const store = connection()
    if (!store) return
    if (!selectedTags.length) return []
    const rows = store.prepare(`SELECT word, phonetic, translation, definition, pos, tag, lookup_key AS lookupKey
      FROM dictionary_entries WHERE instr(' ' || lower(tag) || ' ', ?) > 0 AND trim(translation) <> ''
      ORDER BY lookup_key, word`).all(` ${book.tag} `) as (DictionaryEntry & { lookupKey: string })[]
    const seen = new Set<string>()
    return rows.filter(({ lookupKey, tag }) => {
      if (!selectedTags.some((selected) => ` ${tag.toLowerCase()} `.includes(` ${selected} `))) return false
      if (seen.has(lookupKey)) return false
      seen.add(lookupKey)
      return true
    }).map(({ lookupKey: _lookupKey, ...row }) => ({
      ...row,
      dictionaryMeaning: parseDictionaryMeaning(row.word, row.translation, sourceRevision),
    }))
  }

  return { status, lookup, wordbooks, wordbookDetail, wordbookEntries, close: () => { db?.close(); db = undefined } }
}

export type Ecdict = ReturnType<typeof createEcdict>
