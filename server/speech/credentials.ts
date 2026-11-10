import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { decryptApiKey, encryptApiKey } from './keyEncryption.ts'
import { SpeechError } from './provider.ts'

export const speechMasterKeyFile = '.lexyn-speech-master-key'
export const maxApiKeyLength = 1024
const unavailable = () => new SpeechError('TTS_CREDENTIAL_UNAVAILABLE',
  'The saved MiniMax key cannot be opened. Restore the speech master key or remove and save the API key again.', 503)

function readMasterKey(path: string) {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw unavailable()
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077)) throw unavailable()
    const key = readFileSync(fd)
    if (key.length !== 32) throw unavailable()
    return key
  } finally { closeSync(fd) }
}

function createMasterKey(path: string) {
  const key = randomBytes(32)
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, key, { flag: 'wx', mode: 0o600, flush: true })
  try {
    // Publish without overwriting an existing master key.
    linkSync(temporary, path)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readMasterKey(path)
      if (existing) return existing
    }
    throw unavailable()
  } finally { unlinkSync(temporary) }
}

export function createSpeechCredentials(db: Database.Database, dataDir?: string) {
  const path = dataDir && join(dataDir, speechMasterKeyFile)
  function stored(owner: string) {
    return db.prepare('SELECT ciphertext FROM speech_credentials WHERE owner_id = ?').pluck().get(owner) as string | undefined
  }
  function decrypt(ciphertext: string) {
    try {
      const key = path && readMasterKey(path)
      if (key) return decryptApiKey(ciphertext, key)
    } catch { /* Return a stable, non-sensitive error. */ }
    throw unavailable()
  }
  return {
    read(owner: string) {
      const ciphertext = stored(owner)
      return ciphertext ? decrypt(ciphertext) : undefined
    },
    status(owner: string): 'missing' | 'configured' | 'unavailable' {
      const ciphertext = stored(owner)
      if (!ciphertext) return 'missing'
      try { decrypt(ciphertext); return 'configured' }
      catch { return 'unavailable' }
    },
    save(owner: string, value: string) {
      if (!path) throw unavailable()
      const existing = stored(owner)
      // If the old key cannot be opened, require explicit removal before
      // replacement rather than silently discarding a recoverable credential.
      if (existing) decrypt(existing)
      const master = readMasterKey(path) ?? createMasterKey(path)
      db.prepare(`INSERT INTO speech_credentials (owner_id, ciphertext) VALUES (?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET ciphertext = excluded.ciphertext`)
        .run(owner, encryptApiKey(value, master))
    },
    clear(owner: string) {
      db.prepare('DELETE FROM speech_credentials WHERE owner_id = ?').run(owner)
    },
  }
}
