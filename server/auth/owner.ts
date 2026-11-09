import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'

const sessionLifetime = 14 * 24 * 60 * 60 * 1000
const rateWindow = 60_000
const maxAttempts = 5

interface Owner {
  id: string
  salt: string
  password_hash: string
  login_window: number
  failed_logins: number
}

function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key))
  })
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export async function initializeOwner(db: Database.Database, password: string) {
  if (password.length < 12 || password.length > 256) throw new Error('Use a password of 12–256 characters.')
  const salt = randomBytes(32).toString('hex')
  const hash = await derive(password, salt)
  const inserted = db.prepare('INSERT OR IGNORE INTO owner (singleton, id, salt, password_hash) VALUES (1, ?, ?, ?)')
    .run(randomUUID(), salt, hash.toString('hex'))
  if (!inserted.changes) throw new Error('An Owner already exists.')
}

export function createAuth(db: Database.Database) {
  const reserveAttempt = (now: number) => db.transaction(() => {
    const owner = db.prepare('SELECT * FROM owner WHERE singleton = 1').get() as Owner | undefined
    if (!owner) return { status: 'denied' } as const
    const newWindow = now >= owner.login_window + rateWindow
    if (!newWindow && owner.failed_logins >= maxAttempts) return { status: 'limited' } as const
    const window = newWindow ? now : owner.login_window
    db.prepare('UPDATE owner SET failed_logins = ?, login_window = ? WHERE singleton = 1')
      .run(newWindow ? 1 : owner.failed_logins + 1, window)
    return { owner, window } as const
  }).immediate()

  function session(token: string | undefined, now = Date.now()) {
    if (!token || !/^[\w-]{43}$/.test(token)) return undefined
    return db.prepare('SELECT owner_id AS ownerId, expires_at AS expiresAt FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash(token), now) as { ownerId: string; expiresAt: number } | undefined
  }

  function revoke(token: string | undefined) {
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
  }

  async function login(password: string, oldToken?: string, now = Date.now()) {
    const reserved = reserveAttempt(now)
    if ('status' in reserved) return reserved
    const { owner, window } = reserved
    const candidate = await derive(password, owner.salt)
    if (!timingSafeEqual(candidate, Buffer.from(owner.password_hash, 'hex'))) return { status: 'denied' } as const
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + sessionLifetime
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      db.prepare('UPDATE owner SET failed_logins = 0 WHERE login_window = ?').run(window)
      revoke(oldToken)
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), owner.id, expiresAt)
    }).immediate()
    return { status: 'ok', token, ownerId: owner.id, expiresAt } as const
  }

  return { login, session, revoke }
}
