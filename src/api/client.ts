import { computed, ref, shallowRef } from 'vue'
import type { StudyEndpoints } from '../../shared/contracts/study'

interface OwnerSession { ownerId: string; username: string; expiresAt: number }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) { super(message) }
}

export const session = shallowRef<OwnerSession | null>(null)
export const setupMode = ref<'create' | 'claim' | null>(null)
export const setupRequired = computed(() => setupMode.value !== null)
export const connection = ref<'checking' | 'connected' | 'unavailable' | 'expired' | 'signed-out'>('checking')
const changes = new Set<() => Promise<unknown>>()
const pendingKeys = new Map<string, string>()
let sessionRequests = new AbortController()
let authEpoch = 0
let changingSession = false

export function onStudyChange(refresh: () => Promise<unknown>) {
  changes.add(refresh)
  return () => { changes.delete(refresh) }
}
export async function refreshStudy() {
  await Promise.all([...changes].map((refresh) => refresh()))
}

function setSession(value: OwnerSession | null) {
  if (!value || session.value?.ownerId !== value.ownerId) {
    sessionRequests.abort()
    sessionRequests = new AbortController()
    pendingKeys.clear()
  }
  session.value = value
}

async function request<T>(path: string, options: RequestInit = {}, {
  timeoutMs = 10_000, trackConnection = true, decode,
}: { timeoutMs?: number; trackConnection?: boolean; decode?: (response: Response) => Promise<T> } = {}) {
  const { signal, ...init } = options
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]
  let response: Response
  try {
    response = await fetch('/api/' + path, {
      ...init, signal: AbortSignal.any(signals), credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Lexyn-Client': '1', ...options.headers },
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (trackConnection) connection.value = 'unavailable'
    throw new ApiError(0, 'CONNECTION', 'Could not reach the server. Check your connection and try again.')
  }
  const body = await (response.ok && decode ? decode(response) : response.json().catch(() => null))
  if (signal?.aborted) throw signal.reason
  if (!response.ok || !body) {
    if (trackConnection && (response.status >= 500 || !body)) connection.value = 'unavailable'
    throw new ApiError(response.status, body?.error?.code ?? 'SERVER',
      body?.error?.message ?? 'The server did not return a usable response. Try again.',
      Number(response.headers.get('Retry-After')) || undefined)
  }
  return body as T
}

export async function checkSession() {
  if (changingSession) return
  const epoch = ++authEpoch
  const hadSession = !!session.value || connection.value === 'expired'
  try {
    const status = await request<{ session: OwnerSession | null; setupMode?: NonNullable<typeof setupMode.value> }>('auth/session')
    if (epoch !== authEpoch) return
    setupMode.value = status.setupMode ?? null
    setSession(status.session)
    connection.value = status.session ? 'connected' : hadSession && !setupRequired.value ? 'expired' : 'signed-out'
  } catch {
    if (epoch === authEpoch) connection.value = 'unavailable'
  }
}

async function changeSession(action: () => Promise<OwnerSession | null>) {
  if (changingSession) return
  changingSession = true
  ++authEpoch
  try {
    const value = await action()
    if (value) setupMode.value = null
    setSession(value)
    connection.value = value ? 'connected' : 'signed-out'
  } finally { changingSession = false }
}

export function authenticate(username: string, password: string) {
  return changeSession(async () => {
    const result = await request<{ session: OwnerSession }>('auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    })
    return result.session
  })
}

export function setupOwner(bootstrapToken: string, username: string, password: string) {
  return changeSession(async () => {
    const result = await request<{ session: OwnerSession }>('auth/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken, username, password }),
    })
    return result.session
  })
}

export function signOut() {
  return changeSession(async () => {
    await request('auth/logout', { method: 'POST' })
    return null
  })
}

type Endpoint = keyof StudyEndpoints
export async function study<K extends Endpoint>(path: K, args: StudyEndpoints[K]['args'],
  options: { write?: boolean; post?: boolean; signal?: AbortSignal } = {}): Promise<StudyEndpoints[K]['result']> {
  const owner = session.value
  if (!owner) throw new ApiError(401, 'SESSION', 'Sign in to Lexyn.')
  const body = JSON.stringify(args)
  const fingerprint = path + body
  const signal = AbortSignal.any([sessionRequests.signal, ...(options.signal ? [options.signal] : [])])
  const headers: Record<string, string> = {
    'X-Lexyn-Owner': owner.ownerId,
  }
  const post = options.write || options.post
  if (post) headers['Content-Type'] = 'application/json'
  if (options.write) {
    if (!pendingKeys.has(fingerprint)) pendingKeys.set(fingerprint, crypto.randomUUID())
    headers['Idempotency-Key'] = pendingKeys.get(fingerprint)!
  }
  let result: { data: StudyEndpoints[K]['result'] }
  try {
    result = await request(post ? path : path + '?args=' + encodeURIComponent(body),
      { method: post ? 'POST' : 'GET', headers, body: post ? body : undefined, signal })
    pendingKeys.delete(fingerprint)
    connection.value = 'connected'
  } catch (error) {
    if (!signal.aborted && error instanceof ApiError) {
      if (error.status === 401 || error.code === 'ACCOUNT') {
        setSession(null)
        connection.value = 'expired'
      } else if (error.status >= 400 && error.status < 500 && error.status !== 408) {
        pendingKeys.delete(fingerprint)
      }
    }
    throw error
  }
  if (options.write) await refreshStudy()
  return result.data
}

export const writeDailyNewWords = (value: number) => study('settings/daily', [value], { write: true })

export async function requestSpeech<T>(path: string, method: 'GET' | 'POST' | 'PUT',
  body?: object, caller?: AbortSignal, decode?: (response: Response) => Promise<T>) {
  return ownerFeatureRequest<T>('speech/' + path, method, body, caller, 20_000, decode)
}

export async function ownerFeatureRequest<T>(path: string, method: 'GET' | 'POST' | 'PUT',
  body?: object, caller?: AbortSignal, timeoutMs = 10_000, decode?: (response: Response) => Promise<T>) {
  const owner = session.value
  if (!owner) throw new ApiError(401, 'SESSION', 'Sign in to Lexyn.')
  const signal = AbortSignal.any([sessionRequests.signal, ...(caller ? [caller] : [])])
  try {
    return await request<T>(path, {
      method, signal, body: body && JSON.stringify(body),
      headers: { 'X-Lexyn-Owner': owner.ownerId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    }, { timeoutMs, trackConnection: false, decode })
  } catch (error) {
    if (!signal.aborted && error instanceof ApiError && (error.status === 401 || error.code === 'ACCOUNT')) {
      setSession(null)
      connection.value = 'expired'
    }
    throw error
  }
}
