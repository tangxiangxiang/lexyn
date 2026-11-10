import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'
import { readConfig } from '../config/env.ts'
import { migrate } from '../db/migrations/index.ts'
import { createBootstrapState } from './bootstrap.ts'
import { createAuth, initializeOwner } from './owner.ts'

test('requires a single Owner and a valid origin, rotates sessions and revokes logout', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    const password = 'example-test-only-password'
    await initializeOwner(db, 'test-admin', password)
    await expect(initializeOwner(db, 'test-admin', password)).rejects.toThrow('already exists')
    expect(db.prepare('SELECT password_hash FROM owner').get()).not.toMatchObject({ password_hash: password })
    const origin = 'https://lexyn.example'
    const app = createApp(db, undefined, origin)
    const headers = { Origin: origin, 'X-Lexyn-Client': '1', 'Content-Type': 'application/json' }
    const login = (value: string, cookie = '', source = origin) => app.request('/api/auth/login', {
      method: 'POST', headers: { ...headers, Origin: source, Cookie: cookie }, body: JSON.stringify({ username: 'test-admin', password: value }),
    })
    expect((await login(password, '', 'https://other.example')).status).toBe(403)
    expect((await login('wrong password')).status).toBe(401)
    const first = await login(password)
    expect(first.status).toBe(200)
    const firstCookie = first.headers.get('Set-Cookie')!
    expect(firstCookie).toMatch(/^__Host-lexyn-session=/)
    expect(firstCookie).toContain('HttpOnly')
    expect(firstCookie).toContain('Secure')
    expect(firstCookie).toContain('SameSite=Lax')
    const cookie = firstCookie.split(';')[0]
    const rotated = await login(password, cookie)
    const nextCookie = rotated.headers.get('Set-Cookie')!.split(';')[0]
    expect(nextCookie).not.toBe(cookie)
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(nextCookie.split('=')[1])
    const session = (value: string) => app.request('/api/auth/session', { headers: { ...headers, Cookie: value } })
    expect(await (await session(cookie)).json()).toEqual({ session: null })
    expect(await (await session(nextCookie)).json()).toMatchObject({ session: { ownerId: expect.any(String) } })
    expect((await app.request('/api/auth/logout', { method: 'POST', headers: { ...headers, Cookie: nextCookie } })).status).toBe(200)
    expect(await (await session(nextCookie)).json()).toEqual({ session: null })
    const expiring = (await login(password)).headers.get('Set-Cookie')!.split(';')[0]
    db.prepare('UPDATE sessions SET expires_at = 0').run()
    expect(await (await session(expiring)).json()).toEqual({ session: null })
  } finally {
    db.close()
  }
})

test('limits guesses across requests and rejects insecure production configuration', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    await initializeOwner(db, 'test-admin', 'test-password-not-for-production')
    const origin = 'http://127.0.0.1:3000'
    const app = createApp(db)
    const headers = { Origin: origin, 'X-Lexyn-Client': '1', 'Content-Type': 'application/json' }
    const request = () => app.request('/api/auth/login', { method: 'POST', headers, body: '{"username":"test-admin","password":"wrong password"}' })
    for (let index = 0; index < 4; index++) expect((await request()).status).toBe(401)
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('1')
    expect((await app.request('/api/auth/login', { method: 'POST', headers,
      body: JSON.stringify({ username: ' TEST-ADMIN ', password: 'test-password-not-for-production' }),
    })).status).toBe(200)
    expect(() => readConfig({ NODE_ENV: 'production', LEXYN_PUBLIC_ORIGIN: origin })).toThrow('HTTPS')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await app.request('/api/auth/session', { headers: { ...headers, Cookie: 'bad' } })).status).toBe(200)
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  } finally { db.close() }
})

test('initializes the first Owner from the web with a one-time token and signs in immediately', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    const origin = 'https://lexyn.example.test'
    const token = randomBytes(32).toString('base64url')
    const log = vi.fn()
    const bootstrap = createBootstrapState(token, log)
    const app = createApp(db, undefined, origin, Date.now, { bootstrap })
    const headers = { 'X-Lexyn-Client': '1', 'Content-Type': 'application/json', Origin: origin }
    const post = (bootstrapToken: string, source = origin) => app.request('/api/auth/setup', {
      method: 'POST', headers: { ...headers, Origin: source },
      body: JSON.stringify({ bootstrapToken, username: 'LexynAdmin', password: 'new-owner-test-password' }),
    })
    expect(log).not.toHaveBeenCalled()
    expect(await (await app.request('/api/auth/session', { headers })).json()).toEqual({ session: null, setupRequired: true, setupMode: 'create' })
    expect((await post(token, 'https://other.example.test')).status).toBe(403)
    expect((await app.request('/api/auth/setup', { method: 'POST', headers,
      body: JSON.stringify({ bootstrapToken: token, password: 'new-owner-test-password' }),
    })).status).toBe(400)
    expect(db.prepare('SELECT count(*) FROM owner').pluck().get()).toBe(0)
    expect((await post('invalid')).status).toBe(401)

    const attempts = await Promise.all([post(token), post(token)])
    const created = attempts.find((response) => response.status === 201)!
    expect(created).toBeDefined()
    expect([409, 429]).toContain(attempts.find((response) => response !== created)?.status)
    expect(created.headers.get('Cache-Control')).toBe('no-store')
    const cookie = created.headers.get('Set-Cookie')!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    const { session } = await created.json()
    expect(session.username).toBe('lexynadmin')
    const list = await app.request('/api/library/decks?args=%5B0%2C50%5D', {
      headers: { ...headers, Cookie: cookie.split(';')[0], 'X-Lexyn-Owner': session.ownerId },
    })
    expect(list.status).toBe(200)
    expect((await post(token)).status).toBe(409)
    expect(bootstrap.verify(token)).toBe(false)
    expect(await (await app.request('/api/auth/session', { headers })).json()).toEqual({ session: null })
  } finally { db.close() }
})

test.each([
  { kind: 'current length policy', password: 'phase7a-existing-password', rehash: true },
  { kind: 'legacy length policy', password: '🦊'.repeat(6), rehash: false },
])('preserves existing Owner credentials under the $kind', async ({ password, rehash }) => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    db.exec(`DROP TABLE vocabulary_jobs; DROP TABLE speech_credentials; DROP TABLE speech_settings; DROP TABLE speech_assets;
      ALTER TABLE owner DROP COLUMN username; PRAGMA user_version=3;`)
    const id = randomUUID()
    const salt = randomBytes(32).toString('hex')
    const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex')
    db.prepare('INSERT INTO owner (singleton, id, salt, password_hash) VALUES (1, ?, ?, ?)').run(id, salt, hash)
    migrate(db)
    const auth = createAuth(db)
    expect((await auth.login('other', password)).status).toBe('denied')
    expect((await auth.login('owner', password)).status).toBe('denied')
    expect(await auth.setup('test-admin', password)).toMatchObject({ status: 'ok', ownerId: id, username: 'test-admin' })
    expect(db.prepare('SELECT id, salt, password_hash FROM owner').get()).toMatchObject({
      id, salt: rehash ? '' : salt, password_hash: rehash ? expect.stringMatching(/^scrypt\$v1\$/) : hash,
    })
    expect((await auth.login('test-admin', password)).status).toBe('ok')
  } finally { db.close() }
})

test('accepts the two default Vite origins without trusting other ports or cross-site requests', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    const config = readConfig({}, true)
    const app = createApp(db, undefined, config.publicOrigin, Date.now, config)
    const get = (origin: string, site = 'same-origin') => app.request('/api/auth/session', {
      headers: { Origin: origin, 'Sec-Fetch-Site': site, 'X-Lexyn-Client': '1' },
    })
    expect((await get('http://127.0.0.1:5173')).status).toBe(200)
    expect((await get('http://localhost:5173')).status).toBe(200)
    expect((await get('http://localhost:3000')).status).toBe(403)
    expect((await get('http://localhost:5173', 'cross-site')).status).toBe(403)
    expect(readConfig({ NODE_ENV: 'production', LEXYN_PUBLIC_ORIGIN: 'https://lexyn.example.test' }, true).additionalOrigins).toEqual([])
  } finally { db.close() }
})
