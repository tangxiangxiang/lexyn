import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import type Database from 'better-sqlite3'
import type { BootstrapState } from './bootstrap.ts'
import { createAuth, OwnerAlreadyExists, OwnerPasswordMismatch, ownerSetupMode, SESSION_LIFETIME_MS } from './owner.ts'
import { hasJsonContentType, isSameOriginRequest } from './csrf.ts'
import { KdfGuardError } from './kdfGuard.ts'
import { isValidPassword, isValidUsername } from './password.ts'
import { AuthRateLimiter, SETUP_FAILURE_THRESHOLD, SETUP_FAILURE_WINDOW_MS, SETUP_MAX_BUCKETS } from './rateLimit.ts'

export type AuthEnv = { Variables: { ownerId: string } }
export interface AuthOptions {
  bootstrap?: BootstrapState
  additionalOrigins?: readonly string[]
}

export function apiError(c: Context, status: 400 | 401 | 403 | 409 | 413 | 415 | 429, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

export function createAuthApi(db: Database.Database, publicOrigin: string, { bootstrap, additionalOrigins = [] }: AuthOptions = {}) {
  const auth = createAuth(db)
  const allowedOrigins = new Set([publicOrigin, ...additionalOrigins])
  const secure = publicOrigin.startsWith('https:')
  const name = secure ? '__Host-lexyn-session' : 'lexyn-session'
  const options = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/' }
  const guardOrigin: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (!isSameOriginRequest(c.req.raw.headers, c.req.method, allowedOrigins)) {
      return apiError(c, 403, 'ORIGIN', 'This request is not from the configured application origin.')
    }
    await next()
  }
  const requireOwner: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const session = auth.session(getCookie(c, name))
    if (!session) return apiError(c, 401, 'SESSION', 'Sign in to Lexyn.')
    const expectedOwner = c.req.header('X-Lexyn-Owner')
    if (expectedOwner !== session.ownerId) return apiError(c, 409, 'ACCOUNT', 'The signed-in Owner changed.')
    c.set('ownerId', session.ownerId)
    await next()
  }
  function signedIn(c: Context, { token, ownerId, username, expiresAt }:
    { token: string; ownerId: string; username: string; expiresAt: number }, status: 200 | 201 = 200) {
    setCookie(c, name, token, { ...options, maxAge: SESSION_LIFETIME_MS / 1000, expires: new Date(expiresAt) })
    return c.json({ session: { ownerId, username, expiresAt } }, status)
  }

  const readBody = async (c: Context): Promise<Record<string, unknown>> => {
    const value: unknown = await c.req.json().catch(() => null)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }

  function rateLimited(c: Context, retryAfterMs: number) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
    return apiError(c, 429, 'RATE_LIMIT', 'Too many authentication attempts. Try again shortly.')
  }

  const credentialLimit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => apiError(c, 413, 'AUTH_BODY_SIZE', 'Authentication request is too large.'),
  })
  const setupLimiter = new AuthRateLimiter({
    threshold: SETUP_FAILURE_THRESHOLD, windowMs: SETUP_FAILURE_WINDOW_MS, maxBuckets: SETUP_MAX_BUCKETS,
  })
  let settingUp = false
  const routes = new Hono()
  routes.use('*', guardOrigin)
  routes.get('/session', (c) => {
    const session = auth.session(getCookie(c, name))
    const setupMode = !session && bootstrap ? ownerSetupMode(db) : null
    return c.json({ session: session ?? null, ...(setupMode ? { setupRequired: true, setupMode } : {}) })
  })
  routes.post('/setup', credentialLimit, async (c) => {
    if (!hasJsonContentType(c.req.raw.headers)) return apiError(c, 415, 'CONTENT_TYPE', 'Send application/json.')
    if (!bootstrap || !ownerSetupMode(db)) {
      return apiError(c, 409, 'ALREADY_INITIALIZED', 'Setup is closed. Sign in with the Owner credentials.')
    }
    const { bootstrapToken, username, password } = await readBody(c)
    const setupMode = ownerSetupMode(db)
    if (!setupMode) return apiError(c, 409, 'ALREADY_INITIALIZED', 'An Owner already exists. Sign in instead.')
    const delay = setupLimiter.retryAfter('setup')
    if (settingUp || delay) return rateLimited(c, delay || 1000)
    if (!isValidUsername(username)) return apiError(c, 400, 'CREDENTIALS', 'Choose a valid 3–32 character username.')
    if (typeof password !== 'string' || (setupMode === 'create' && !isValidPassword(password))) {
      return apiError(c, 400, 'CREDENTIALS', 'Use a 12–256 character password.')
    }
    if (typeof bootstrapToken !== 'string' || !bootstrap.verify(bootstrapToken)) {
      const { retryAfterMs } = setupLimiter.recordFailure('setup')
      if (retryAfterMs) return rateLimited(c, retryAfterMs)
      return apiError(c, 401, 'SETUP_TOKEN', 'Enter the current setup token from the server terminal.')
    }

    settingUp = true
    try {
      const result = await auth.setup(username, password, c.req.raw.signal)
      bootstrap.markOwnerCommitted()
      return signedIn(c, result, 201)
    } catch (error) {
      if (error instanceof OwnerAlreadyExists) {
        bootstrap.markOwnerCommitted()
        return apiError(c, 409, 'ALREADY_INITIALIZED', 'An Owner already exists. Sign in instead.')
      }
      if (error instanceof OwnerPasswordMismatch) {
        const { retryAfterMs } = setupLimiter.recordFailure('setup')
        if (retryAfterMs) return rateLimited(c, retryAfterMs)
        return apiError(c, 401, 'CREDENTIALS', error.message)
      }
      if (error instanceof KdfGuardError) return rateLimited(c, 1000)
      throw error
    } finally { settingUp = false }
  })
  routes.post('/login', credentialLimit, async (c) => {
    if (!hasJsonContentType(c.req.raw.headers)) return apiError(c, 415, 'CONTENT_TYPE', 'Send application/json.')
    const { username, password } = await readBody(c)
    if (typeof username !== 'string' || typeof password !== 'string') {
      return apiError(c, 400, 'CREDENTIALS', 'Username and password are required.')
    }
    try {
      const login = await auth.login(username, password, getCookie(c, name), c.req.raw.signal)
      if (login.status === 'limited') return rateLimited(c, login.retryAfterMs)
      if (login.status !== 'ok') return apiError(c, 401, 'CREDENTIALS', 'Invalid username or password.')
      return signedIn(c, login)
    } catch (error) {
      if (error instanceof KdfGuardError) return rateLimited(c, 1000)
      throw error
    }
  })
  routes.post('/logout', (c) => {
    auth.revoke(getCookie(c, name))
    setCookie(c, name, '', { ...options, maxAge: 0 })
    return c.json({ session: null })
  })
  return { routes, guardOrigin, requireOwner }
}
