import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import type Database from 'better-sqlite3'
import { createAuth } from './owner.ts'
import { serverGeneration } from '../backup/generation.ts'

export type AuthEnv = { Variables: { ownerId: string } }

export function apiError(c: Context, status: 400 | 401 | 403 | 409 | 429, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

export function createAuthApi(db: Database.Database, publicOrigin: string) {
  const auth = createAuth(db)
  const secure = publicOrigin.startsWith('https:')
  const name = secure ? '__Host-lexyn-session' : 'lexyn-session'
  const options = { httpOnly: true, secure, sameSite: 'Strict' as const, path: '/' }
  const guardOrigin: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const origin = c.req.header('Origin')
    const site = c.req.header('Sec-Fetch-Site')
    if (c.req.header('X-Lexyn-Client') !== '1' || (site && site !== 'same-origin' && site !== 'none')
      || (origin !== undefined && origin !== publicOrigin)
      || (c.req.method !== 'GET' && origin !== publicOrigin)) {
      return apiError(c, 403, 'ORIGIN', 'This request is not from the configured application origin.')
    }
    await next()
  }
  const requireOwner: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const session = auth.session(getCookie(c, name))
    if (!session) return apiError(c, 401, 'SESSION', 'Sign in to synchronize.')
    const expectedOwner = c.req.header('X-Lexyn-Owner')
    if (expectedOwner !== session.ownerId) return apiError(c, 409, 'ACCOUNT', 'The signed-in Owner changed.')
    if (c.req.header('X-Lexyn-Generation') !== serverGeneration(db)) {
      return apiError(c, 409, 'GENERATION', 'The server was restored. Keep this browser’s saved data and use a separate browser profile to sync.')
    }
    c.set('ownerId', session.ownerId)
    await next()
  }
  const routes = new Hono()
  routes.use('*', guardOrigin)
  routes.get('/session', (c) => {
    const session = auth.session(getCookie(c, name))
    return c.json({ session: session ? { ...session, generation: serverGeneration(db) } : null })
  })
  routes.post('/login', bodyLimit({ maxSize: 4096 }), async (c) => {
    const body: unknown = c.req.header('Content-Type')?.split(';')[0] === 'application/json'
      ? await c.req.json().catch(() => null) : null
    const password = body && typeof body === 'object' && 'password' in body ? body.password : undefined
    if (typeof password !== 'string' || !password || password.length > 256) {
      return apiError(c, 400, 'CREDENTIALS', 'Sign-in credentials are invalid.')
    }
    const login = await auth.login(password, getCookie(c, name))
    if (login.status === 'limited') {
      c.header('Retry-After', '60')
      return apiError(c, 429, 'RATE_LIMIT', 'Too many sign-in attempts. Try again in a minute.')
    }
    if (login.status !== 'ok') return apiError(c, 401, 'CREDENTIALS', 'Sign-in credentials are invalid.')
    setCookie(c, name, login.token, { ...options, expires: new Date(login.expiresAt) })
    return c.json({ session: { ownerId: login.ownerId, expiresAt: login.expiresAt, generation: serverGeneration(db) } })
  })
  routes.post('/logout', (c) => {
    auth.revoke(getCookie(c, name))
    setCookie(c, name, '', { ...options, maxAge: 0 })
    return c.json({ session: null })
  })
  return { routes, guardOrigin, requireOwner }
}
