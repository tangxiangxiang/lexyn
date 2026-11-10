import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { defaultKdfGuard } from './kdfGuard.ts'
import { hashPassword, isValidPassword, normalizeUsername, verifyPassword } from './password.ts'
import { AuthRateLimiter } from './rateLimit.ts'

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const DUMMY_PASSWORD_HASH = 'scrypt$v1$N=32768,r=8,p=1$vxB7driim0d14ZL4x7e7xA$ii4iR3nQJbaXGQ4irXtmyqVBqk4KFukoTQxVsx-VKQw'
const LEGACY_DUMMY_SALT = '0'.repeat(64)

interface Owner {
  id: string
  username: string | null
  salt: string
  password_hash: string
}

function legacyDerive(password: string, salt: string, signal?: AbortSignal) {
  return defaultKdfGuard.run(signal, () => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key))
  }))
}

function acceptsPassword(owner: Owner | undefined, password: string) {
  // The old policy counted UTF-16 code units. Keep previously accepted passwords usable.
  return owner?.salt ? password.length >= 12 && password.length <= 256 : isValidPassword(password)
}

async function verifyCredentials(password: string, owner: Owner | undefined, legacy: boolean, signal?: AbortSignal) {
  if (!legacy) return verifyPassword(password, owner?.password_hash ?? DUMMY_PASSWORD_HASH, { signal })
  const key = await legacyDerive(password, owner?.salt ?? LEGACY_DUMMY_SALT, signal)
  const hash = owner && Buffer.from(owner.password_hash, 'hex')
  return !!hash && hash.length === key.length && timingSafeEqual(key, hash)
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export class OwnerAlreadyExists extends Error {}
export class OwnerPasswordMismatch extends Error {}

function readOwner(db: Database.Database) {
  return db.prepare('SELECT id, username, salt, password_hash FROM owner WHERE singleton = 1').get() as Owner | undefined
}

export function ownerSetupMode(db: Database.Database) {
  const owner = readOwner(db)
  return !owner ? 'create' : owner.username === null ? 'claim' : null
}

export function ownerExists(db: Database.Database) {
  return !!db.prepare('SELECT 1 FROM owner WHERE singleton = 1').get()
}

async function prepareOwner(username: string, password: string, signal?: AbortSignal) {
  return { id: randomUUID(), username: normalizeUsername(username), hash: await hashPassword(password, { signal }) }
}

function insertOwner(db: Database.Database, owner: Awaited<ReturnType<typeof prepareOwner>>) {
  const inserted = db.prepare("INSERT OR IGNORE INTO owner (singleton, id, username, salt, password_hash) VALUES (1, ?, ?, '', ?)")
    .run(owner.id, owner.username, owner.hash)
  if (!inserted.changes) throw new OwnerAlreadyExists('An Owner already exists.')
}

export async function initializeOwner(db: Database.Database, username: string, password: string) {
  if (ownerExists(db)) throw new OwnerAlreadyExists('An Owner already exists.')
  insertOwner(db, await prepareOwner(username, password))
}

export function createAuth(db: Database.Database) {
  const loginLimiter = new AuthRateLimiter()

  function session(token: string | undefined, now = Date.now()) {
    if (!token || !/^[\w-]{43}$/.test(token)) return undefined
    return db.prepare(`SELECT owner_id AS ownerId, owner.username, expires_at AS expiresAt FROM sessions
      JOIN owner ON owner.id = sessions.owner_id WHERE token_hash = ? AND expires_at > ? AND owner.username IS NOT NULL`)
      .get(tokenHash(token), now) as { ownerId: string; username: string; expiresAt: number } | undefined
  }

  function revoke(token: string | undefined) {
    if (token && /^[\w-]{43}$/.test(token)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
  }

  function issueSession(ownerId: string, username: string, now: number) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + SESSION_LIFETIME_MS
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), ownerId, expiresAt)
    return { status: 'ok', token, ownerId, username, expiresAt } as const
  }

  async function setup(username: string, password: string, signal?: AbortSignal) {
    const normalized = normalizeUsername(username)
    const existing = readOwner(db)
    if (!existing) {
      const owner = await prepareOwner(normalized, password, signal)
      return db.transaction(() => {
        insertOwner(db, owner)
        return issueSession(owner.id, owner.username, Date.now())
      }).immediate()
    }
    if (existing.username !== null) throw new OwnerAlreadyExists('An Owner already exists.')
    if (!acceptsPassword(existing, password) || !await verifyCredentials(password, existing, !!existing.salt, signal)) {
      throw new OwnerPasswordMismatch('The current Owner password is incorrect.')
    }
    const upgradedHash = existing.salt && isValidPassword(password) ? await hashPassword(password, { signal }) : undefined
    return db.transaction(() => {
      const result = db.prepare(`UPDATE owner SET username=?, salt=?, password_hash=?
        WHERE id=? AND username IS NULL AND password_hash=?`).run(normalized, upgradedHash ? '' : existing.salt,
        upgradedHash ?? existing.password_hash, existing.id, existing.password_hash)
      if (!result.changes) throw new OwnerAlreadyExists('An Owner already exists.')
      return issueSession(existing.id, normalized, Date.now())
    }).immediate()
  }

  // Nuvyn verifies valid credentials even when a failure bucket is hot, so
  // repeated guesses cannot lock the only Owner out of the application.
  async function login(username: string, password: string, oldToken?: string, signal?: AbortSignal) {
    let normalized: string | undefined
    try { normalized = normalizeUsername(username) } catch { /* Generic credential failure below. */ }
    const failure = () => {
      const { retryAfterMs } = loginLimiter.recordFailure(normalized ?? '<invalid-username>')
      return retryAfterMs > 0 ? { status: 'limited', retryAfterMs } as const : { status: 'denied' } as const
    }
    const owner = readOwner(db)
    if (!acceptsPassword(owner, password)) return failure()
    const candidate = owner && owner.username === normalized ? owner : undefined
    const verified = await verifyCredentials(password, candidate, !!owner?.salt, signal)
    if (!candidate?.username || !verified) return failure()
    const usernameForSession = candidate.username
    const upgradedHash = candidate.salt && isValidPassword(password) ? await hashPassword(password, { signal }) : undefined

    loginLimiter.reset(candidate.username)
    const now = Date.now()
    return db.transaction(() => {
      if (upgradedHash) db.prepare("UPDATE owner SET salt='', password_hash=? WHERE id=? AND password_hash=?")
        .run(upgradedHash, candidate.id, candidate.password_hash)
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      revoke(oldToken)
      return issueSession(candidate.id, usernameForSession, now)
    }).immediate()
  }

  return { login, session, revoke, setup }
}
