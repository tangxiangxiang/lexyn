import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'
import { readConfig } from '../config/env.ts'
import { migrate } from '../db/migrations/index.ts'
import { initializeOwner } from './owner.ts'

test('requires a single Owner and a valid origin, rotates sessions and revokes logout', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    const password = 'example-test-only-password'
    await initializeOwner(db, password)
    await expect(initializeOwner(db, password)).rejects.toThrow('already exists')
    expect(db.prepare('SELECT password_hash FROM owner').get()).not.toMatchObject({ password_hash: password })
    const origin = 'https://lexyn.example'
    const app = createApp(db, undefined, origin)
    const headers = { Origin: origin, 'X-Lexyn-Client': '1', 'Content-Type': 'application/json' }
    const login = (value: string, cookie = '', source = origin) => app.request('/api/auth/login', {
      method: 'POST', headers: { ...headers, Origin: source, Cookie: cookie }, body: JSON.stringify({ password: value }),
    })
    expect((await login(password, '', 'https://other.example')).status).toBe(403)
    expect((await login('wrong password')).status).toBe(401)
    const first = await login(password)
    expect(first.status).toBe(200)
    const firstCookie = first.headers.get('Set-Cookie')!
    expect(firstCookie).toMatch(/^__Host-lexyn-session=/)
    expect(firstCookie).toContain('HttpOnly')
    expect(firstCookie).toContain('Secure')
    expect(firstCookie).toContain('SameSite=Strict')
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
    await initializeOwner(db, 'test-password-not-for-production')
    const origin = 'http://127.0.0.1:3000'
    const app = createApp(db)
    const headers = { Origin: origin, 'X-Lexyn-Client': '1', 'Content-Type': 'application/json' }
    const request = () => app.request('/api/auth/login', { method: 'POST', headers, body: '{"password":"wrong"}' })
    for (let index = 0; index < 5; index++) expect((await request()).status).toBe(401)
    expect((await request()).status).toBe(429)
    expect(() => readConfig({ NODE_ENV: 'production', LEXYN_PUBLIC_ORIGIN: origin })).toThrow('HTTPS')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await app.request('/api/auth/session', { headers: { ...headers, Cookie: 'bad' } })).status).toBe(200)
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  } finally { db.close() }
})
