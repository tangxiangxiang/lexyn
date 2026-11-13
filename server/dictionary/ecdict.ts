import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { dictionaryLimits } from '../../shared/domain/dictionary.ts'
import { builtinWordbooks, type BuiltinWordbookId } from '../../shared/domain/builtin-books.ts'
import { classificationPath } from './classification.ts'
import { buildWordbookIndex, emptyWordbook, queryWordbook, wordbookCounts, type PreviewOptions, type WordState } from './wordbooks.ts'
import type { VocabularySource, WordClassification } from '../../shared/contracts/wordbooks.ts'
import { parseDictionaryMeaning } from './parse.ts'
import type { DictionaryEntry, DictionaryLookup, DictionaryStatus } from '../../shared/contracts/dictionary.ts'

export const dictionaryPath = (dataDir: string) => join(dataDir, 'dictionaries', 'ecdict.sqlite')
export const lookupKey = (word: string) => word.trim().normalize('NFC').toLowerCase().normalize('NFC')

const lookupLimit = 12
export function createEcdict(dataDir?: string) {
  let db: Database.Database | undefined
  let sourceRevision: string | undefined
  let error: string | undefined
  let legacy = false
  let counts: ReturnType<typeof wordbookCounts> | undefined
  let hasClassification = false
  const path = dataDir ? dictionaryPath(dataDir) : undefined

  function connection() {
    if (db) return db
    if (!path || !existsSync(path)) return
    try {
      const opened = new Database(path, { readonly: true, fileMustExist: true })
      const version = opened.pragma('user_version', { simple: true })
      if ((version !== 1 && version !== 2)
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
      legacy = version === 1
      db = opened
      error = undefined
      return db
    } catch {
      error = 'Could not open ECDICT. Reimport the dictionary.'
      return
    }
  }

  function metadata(store: Database.Database) {
    return Object.fromEntries((store.prepare('SELECT key, value FROM dictionary_meta').all() as { key: string; value: string }[])
      .map(({ key, value }) => [key, value]))
  }

  function status(): DictionaryStatus {
    const store = connection()
    if (!store) return { installed: false, wordCount: 0, ...(error ? { error } : {}) }
    try {
      const meta = metadata(store)
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

  function index() {
    const store = connection()
    if (!store || counts) return store
    if (legacy) buildWordbookIndex(store, true)
    const classification = dataDir && classificationPath(dataDir)
    if (classification && existsSync(classification)) {
      store.prepare('ATTACH DATABASE ? AS classification').run(classification)
      hasClassification = true
    }
    counts = wordbookCounts(store)
    return store
  }

  function wordbooks() {
    const store = index()
    return {
      installed: !!store,
      books: builtinWordbooks.map(({ id, name, tag }) => {
        const count = tag ? counts?.get(tag) ?? 0 : 0
        return { id, name, count, available: count > 0 }
      }),
    }
  }

  function wordbook(id: BuiltinWordbookId, options: PreviewOptions, states: WordState[], install = false) {
    const store = index()
    if (!store) return { ...emptyWordbook(options.selectedTags), installed: false, cefrAvailable: false, cefrLevels: [] as NonNullable<WordClassification['cefr']>[], rows: [] as DictionaryEntry[] }
    const meta = metadata(store)
    const source: VocabularySource = {
      name: 'ECDICT', url: 'https://github.com/skywind3000/ECDICT', version: sourceRevision ?? 'unknown',
      importedAt: meta.importedAt, sha256: meta.csvSha256, license: 'MIT (repository declaration)',
      redistribution: 'verify-upstream-rights', wordCount: Number(meta.wordCount),
      fields: meta.fields ? JSON.parse(meta.fields) : ['word', 'phonetic', 'definition', 'translation', 'pos', 'tag', 'bnc', 'frq', 'exchange'],
    }
    const profiles = hasClassification
      ? (store.prepare('SELECT body FROM classification.sources ORDER BY name').pluck().all() as string[])
        .map((body) => JSON.parse(body) as VocabularySource) : []
    const cefrLevels = profiles.length
      ? store.prepare('SELECT DISTINCT level FROM classification.levels ORDER BY level').pluck().all() as NonNullable<WordClassification['cefr']>[]
      : []
    const result = queryWordbook(store, id, options, states, [source, ...profiles], profiles.length > 0, install)
    return { ...result, installed: true, cefrAvailable: profiles.length > 0, cefrLevels,
      rows: result.rows.map(({ word, phonetic, translation, definition, pos, tag }) => ({
        word, phonetic: phonetic.trim(), translation, definition, pos, tag,
        dictionaryMeaning: parseDictionaryMeaning(word, translation, sourceRevision),
      })) }
  }

  return { status, lookup, wordbooks, wordbook, dataDir,
    close: () => { db?.close(); db = undefined; counts = undefined; hasClassification = false } }
}

export type Ecdict = ReturnType<typeof createEcdict>
