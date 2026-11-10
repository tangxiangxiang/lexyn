import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { lockDataDirectory } from '../db/database.ts'
import { latestDatabaseVersion } from '../db/migrations/index.ts'

const databaseName = 'lexyn.sqlite'
const infoName = 'backup.json'
const requiredTables = ['owner', 'sessions', 'decks', 'entries', 'practice_events', 'learn_progress', 'learn_sessions',
  'review_events', 'review_cards', 'review_sessions', 'owner_settings', 'request_idempotency']

const hasSidecars = (path: string) => ['-wal', '-shm', '-journal'].some((suffix) => existsSync(path + suffix))

const isSupportedSchema = (version: unknown): version is number =>
  Number.isInteger(version) && Number(version) >= 3 && Number(version) <= latestDatabaseVersion

function verifyDatabase(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const version = db.pragma('user_version', { simple: true })
    if (!isSupportedSchema(version)) throw new Error('This SQLite schema is incompatible with this Lexyn build.')
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all())
    if (!requiredTables.every((table) => tables.has(table))) throw new Error('The SQLite backup is missing required tables.')
    if (version >= 7 && (!tables.has('speech_settings') || !tables.has('speech_assets'))) {
      throw new Error('The SQLite backup is missing speech tables.')
    }
    if (version >= 8 && !tables.has('speech_credentials')) throw new Error('The SQLite backup is missing speech credentials.')
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[]
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) {
      throw new Error('The SQLite backup failed its integrity check.')
    }
    return version
  } finally { db.close() }
}

async function fingerprint(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error('The backup database must be a regular file.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: stat.size, sha256: hash.digest('hex') }
}

export async function createSqliteBackup(dataDir: string, backupDir: string) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const temp = mkdtempSync(join(backupDir, '.lexyn-incomplete-'))
  chmodSync(temp, 0o700)
  const path = join(temp, databaseName)
  try {
    const source = new Database(join(dataDir, databaseName), { readonly: true, fileMustExist: true })
    try { await source.backup(path) } finally { source.close() }
    chmodSync(path, 0o600)
    const snapshot = new Database(path, { fileMustExist: true })
    try { snapshot.pragma('journal_mode = DELETE') } finally { snapshot.close() }
    const schemaVersion = verifyDatabase(path)
    const createdAt = new Date().toISOString()
    const info = { format: 'lexyn-sqlite', version: 1, schemaVersion, createdAt, ...await fingerprint(path) }
    writeFileSync(join(temp, infoName), JSON.stringify(info, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    const final = resolve(backupDir, `lexyn-${createdAt.replaceAll(':', '-')}-${randomUUID()}`)
    renameSync(temp, final)
    return { directory: final, ...info }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

export async function verifySqliteBackup(directory: string) {
  const infoPath = join(directory, infoName)
  const stat = lstatSync(infoPath)
  if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid SQLite backup metadata file.')
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as Record<string, unknown> | null
  if (!info || info.format !== 'lexyn-sqlite' || info.version !== 1 || !isSupportedSchema(info.schemaVersion)
    || typeof info.createdAt !== 'string' || !Number.isFinite(Date.parse(info.createdAt))) {
    throw new Error('Invalid or unsupported SQLite backup metadata.')
  }
  const path = join(directory, databaseName)
  if (hasSidecars(path)) throw new Error('The SQLite backup must be a standalone file without sidecars.')
  const actual = await fingerprint(path)
  if (actual.bytes !== info.bytes || actual.sha256 !== info.sha256) throw new Error('SQLite backup size or SHA-256 does not match.')
  const schemaVersion = verifyDatabase(path)
  if (schemaVersion !== info.schemaVersion) throw new Error('SQLite backup schema version does not match its metadata.')
  return { ...actual, schemaVersion, createdAt: info.createdAt }
}

export async function restoreSqliteBackup(dataDir: string, directory: string) {
  const target = resolve(dataDir, databaseName)
  const source = resolve(directory, databaseName)
  if (target === source) throw new Error('The backup and live database paths must differ.')
  const info = await verifySqliteBackup(directory)
  const unlock = lockDataDirectory(dataDir)
  let temp: string | undefined
  try {
    if (hasSidecars(target)) {
      throw new Error('The target has SQLite sidecar files. Stop Lexyn cleanly and verify the target before restoring.')
    }
    temp = mkdtempSync(join(dataDir, '.lexyn-restore-'))
    const staged = join(temp, databaseName)
    copyFileSync(source, staged)
    // Only promote the exact standalone file that passed verification.
    const recheck = await fingerprint(staged)
    if (recheck.sha256 !== info.sha256) throw new Error('The SQLite backup changed during restore.')
    chmodSync(staged, 0o600)
    const db = new Database(staged, { fileMustExist: true })
    try {
      db.pragma('journal_mode = DELETE')
      db.prepare('DELETE FROM sessions').run()
    } finally { db.close() }
    verifyDatabase(staged)
    let rollback: string | undefined
    if (existsSync(target)) {
      if (!lstatSync(target).isFile()) throw new Error('The target must be a regular SQLite file.')
      rollback = `${target}.rollback-${randomUUID()}`
      linkSync(target, rollback)
    }
    renameSync(staged, target)
    return { target, rollback }
  } finally {
    try { if (temp) rmSync(temp, { recursive: true, force: true }) } finally { unlock() }
  }
}
