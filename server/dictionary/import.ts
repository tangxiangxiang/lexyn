import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import Papa from 'papaparse'
import { dictionaryPath, lookupKey } from './ecdict.ts'

type CsvRow = Record<string, string>
const required = ['word', 'phonetic', 'definition', 'translation', 'pos', 'tag', 'bnc', 'frq', 'exchange']
const maxFieldLength = 20_000

async function checksum(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Import into a new database, never into the active Lexyn user database. */
export async function importEcdictCsv(dataDir: string, csvPath: string, sourceCommit = 'unknown') {
  const target = dictionaryPath(dataDir)
  const temporary = target + '.' + randomUUID() + '.tmp'
  const backup = target + '.' + randomUUID() + '.backup'
  mkdirSync(dirname(target), { recursive: true })
  const hash = await checksum(csvPath)
  let db: Database.Database | undefined
  let count = 0
  let swapped = false
  let oldMoved = false
  try {
    db = new Database(temporary)
    db.exec(
      'CREATE TABLE dictionary_entries (word TEXT PRIMARY KEY NOT NULL, lookup_key TEXT NOT NULL, phonetic TEXT NOT NULL, translation TEXT NOT NULL, definition TEXT NOT NULL, pos TEXT NOT NULL, tag TEXT NOT NULL, bnc TEXT NOT NULL, frq TEXT NOT NULL, exchange TEXT NOT NULL) STRICT;' +
      'CREATE TABLE dictionary_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;'
    )
    const insert = db.prepare(
      'INSERT INTO dictionary_entries (word, lookup_key, phonetic, translation, definition, pos, tag, bnc, frq, exchange)' +
      ' VALUES (@word, @lookup_key, @phonetic, @translation, @definition, @pos, @tag, @bnc, @frq, @exchange)' +
      ' ON CONFLICT(word) DO UPDATE SET phonetic=excluded.phonetic, translation=excluded.translation,' +
      ' definition=excluded.definition, pos=excluded.pos, tag=excluded.tag, bnc=excluded.bnc, frq=excluded.frq, exchange=excluded.exchange'
    )
    const commit = db.transaction((rows: CsvRow[]) => {
      for (const row of rows) insert.run({
        word: row.word.trim().normalize('NFC'), lookup_key: lookupKey(row.word),
        phonetic: row.phonetic || '', translation: row.translation || '', definition: row.definition || '',
        pos: row.pos || '', tag: row.tag || '', bnc: row.bnc || '', frq: row.frq || '', exchange: row.exchange || '',
      })
    })
    const parser = Papa.parse(Papa.NODE_STREAM_INPUT, { header: true, skipEmptyLines: true }) as NodeJS.ReadWriteStream
    const source = createReadStream(csvPath).pipe(parser)
    let buffer: CsvRow[] = []
    let headerChecked = false
    for await (const value of source) {
      const row = value as unknown as CsvRow
      if (!headerChecked) {
        const columns = Object.keys(row).map((s) => s.replace(/^\uFEFF/, ''))
        if (required.some((key) => !columns.includes(key))) throw new Error('Invalid ECDICT CSV header.')
        headerChecked = true
      }
      if (Object.hasOwn(row, '__parsed_extra') || required.some((key) => typeof row[key] !== 'string')
        || Object.values(row).some((value) => typeof value !== 'string' || value.length > maxFieldLength)) {
        throw new Error('Invalid ECDICT CSV record.')
      }
      if (!row.word.trim()) continue
      buffer.push(row)
      if (buffer.length >= 1000) { commit(buffer); buffer = [] }
    }
    if (buffer.length) commit(buffer)
    count = db.prepare('SELECT count(*) FROM dictionary_entries').pluck().get() as number
    if (!headerChecked || count < 1) throw new Error('ECDICT CSV contains no valid entries.')
    db.exec('CREATE INDEX dictionary_lookup ON dictionary_entries(lookup_key);')
    const metadata = db.prepare('INSERT INTO dictionary_meta (key, value) VALUES (?, ?)')
    db.transaction(() => {
      for (const [key, value] of Object.entries({
        source: 'skywind3000/ECDICT', sourceCommit, csvSha256: hash, wordCount: String(count),
        importedAt: new Date().toISOString(),
      })) metadata.run(key, value)
    })()
    db.pragma('user_version = 1')
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('ECDICT SQLite integrity check failed.')
    db.close()
    db = undefined
    // Keep the current dictionary live until the new database is fully built.
    // POSIX rename atomically replaces the target; Windows replacement may fail safely.
    if (existsSync(target)) { copyFileSync(target, backup); oldMoved = true }
    renameSync(temporary, target)
    swapped = true
    if (oldMoved) { rmSync(backup); oldMoved = false }
    return { count, sha256: hash, bytes: statSync(target).size }
  } finally {
    db?.close()
    if (!swapped) rmSync(temporary, { force: true })
  }
}
