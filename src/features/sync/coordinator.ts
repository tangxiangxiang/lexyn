import { liveQuery } from 'dexie'
import { computed, ref, shallowRef } from 'vue'
import { SYNC_VERSION, type OwnerSession, type PushResponse, type SyncPage } from '../../../shared/contracts/sync'
import { db } from '../../db/local'
import { SyncError, syncStore } from './repository'

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function request<T>(path: string, options: { body?: unknown; ownerId?: string; push?: boolean } = {}) {
  const headers: Record<string, string> = { 'X-Lexyn-Client': '1' }
  if (options.ownerId) headers['X-Lexyn-Owner'] = options.ownerId
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch('/api' + path, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers, credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const json = await response.json().catch(() => undefined)
  if (!response.ok && !(options.push && response.status === 409 && Array.isArray(json?.results))) {
    throw new RequestError(json?.error?.message || 'The server could not complete synchronization.', response.status)
  }
  if (json === undefined) throw new SyncError('The server response was not readable.')
  return json as T
}

const session = shallowRef<OwnerSession | null>()
const data = shallowRef<Awaited<ReturnType<typeof syncStore.status>>>()
const syncBusy = ref(false)
const authBusy = ref(false)
const online = ref(true)
const error = ref('')
const authError = ref('')
let timer: number | undefined
let running: Promise<void> | undefined
let failures = 0
let started = false
let authEpoch = 0

const status = computed(() => {
  if (syncBusy.value) return 'Syncing'
  if (data.value?.issues.length || data.value?.hidden || data.value?.legacy || error.value) return 'Needs attention'
  if (!online.value) return data.value?.pending ? 'Offline · changes waiting' : 'Offline'
  if (!session.value) return 'Local only · sign in to sync'
  if (data.value?.pending) return 'Changes waiting'
  return data.value?.state?.lastSuccessAt ? 'Synced' : 'Waiting for first sync'
})

function schedule(delay = 700) {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => { void synchronize() }, delay)
}

async function runSync(retryRejected: boolean) {
  online.value = navigator.onLine
  if (!online.value || authBusy.value) return
  syncBusy.value = true
  error.value = ''
  const leaseId = crypto.randomUUID()
  const epoch = authEpoch
  let acquired = false
  let success = false
  try {
    const result = await request<{ session: OwnerSession | null }>('/auth/session')
    if (epoch !== authEpoch) return
    session.value = result.session
    if (!result.session) return
    const ownerId = result.session.ownerId
    const claimed = await syncStore.acquire(ownerId, window.location.origin, leaseId)
    if (!claimed) return
    acquired = true
    if (retryRejected) await syncStore.retryRejected()
    // Send an empty batch on a fresh device so it is registered before bootstrap.
    let first = true
    for (;;) {
      const state = await syncStore.renew(leaseId)
      const operations = await syncStore.batch(leaseId)
      if (!operations.length && !first) break
      if (epoch !== authEpoch) return
      const response = await request<PushResponse>('/sync/push', {
        ownerId, push: true, body: { schemaVersion: SYNC_VERSION, deviceId: state.deviceId, cursor: state.cursor, operations },
      })
      await syncStore.acknowledge(leaseId, operations, response)
      first = false
    }
    for (;;) {
      const state = await syncStore.renew(leaseId)
      if (epoch !== authEpoch) return
      const bootstrap = !state.bootstrapped
      const query = new URLSearchParams({ after: String(state.cursor) })
      if (bootstrap && state.through !== undefined) query.set('through', String(state.through))
      const path = bootstrap ? '/bootstrap?' : '/sync/pull?'
      const page = await request<SyncPage>(path + query, { ownerId })
      await syncStore.apply(leaseId, page, bootstrap)
      if (!bootstrap && !page.hasMore) break
    }
    failures = 0
    success = true
  } catch (cause) {
    if (epoch !== authEpoch) return
    if (cause instanceof RequestError && cause.status === 401) {
      session.value = null
      error.value = 'Your session expired. Sign in to sync your saved changes.'
      return
    }
    error.value = cause instanceof SyncError || cause instanceof RequestError ? cause.message
      : 'Synchronization could not finish. Your local changes are saved.'
    const transient = !(cause instanceof SyncError) && (!(cause instanceof RequestError) || cause.status >= 500)
    if (transient && ++failures <= 6 && navigator.onLine) schedule(Math.min(60_000, 1000 * 2 ** failures))
    else if (!transient) failures = 6
  } finally {
    if (acquired) {
      try {
        await syncStore.release(leaseId, success)
      } catch {
        error.value = 'Local synchronization state could not be saved.'
      }
    }
    syncBusy.value = false
  }
}

function synchronize(retryRejected = false) {
  if (!running) {
    running = runSync(retryRejected).finally(() => { running = undefined })
  }
  return running
}

async function manualSync() {
  failures = 0
  window.clearTimeout(timer)
  if (running) await running
  await synchronize(true)
}

async function authenticate(path: 'login' | 'logout', password?: string) {
  if (authBusy.value) return
  authBusy.value = true
  authError.value = ''
  authEpoch++
  try {
    const result = await request<{ session: OwnerSession | null }>('/auth/' + path, {
      body: path === 'login' ? { password } : {},
    })
    session.value = result.session
    error.value = ''
    failures = 0
  } catch (cause) {
    authError.value = cause instanceof RequestError ? cause.message : 'Could not contact the sign-in service.'
  } finally {
    authBusy.value = false
  }
  if (path === 'login' && session.value && !authError.value) {
    if (running) await running
    await synchronize()
  }
}

async function resolveConflict(opId: string, choice: 'server' | 'local', term?: string) {
  await syncStore.resolve(opId, choice, term)
  failures = 0
  schedule(0)
}

export function startSyncCoordinator() {
  if (started) return
  started = true
  online.value = navigator.onLine
  void syncStore.initialize().then(() => {
    liveQuery(syncStore.status).subscribe({
      next: (value) => { data.value = value },
      error: () => { error.value = 'Could not read local synchronization state.' },
    })
    let last: string | undefined
    liveQuery(() => db.sync_meta.get('library.outbox.sequence')).subscribe({
      next: (value) => {
        if (value?.value !== last && session.value) schedule()
        last = value?.value
      },
      error: () => { error.value = 'Could not read pending local operations.' },
    })
    void synchronize()
  }).catch(() => { error.value = 'Could not initialize local synchronization.' })
  window.addEventListener('online', () => { online.value = true; failures = 0; schedule(0) })
  window.addEventListener('offline', () => { online.value = false; window.clearTimeout(timer) })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { failures = 0; schedule(0) }
  })
  window.addEventListener('focus', () => { failures = 0; schedule(0) })
  window.setInterval(() => {
    if (session.value && document.visibilityState === 'visible' && !failures) void synchronize()
  }, 30_000)
}

export const synchronization = {
  session, data, syncBusy, authBusy, online, status, error, authError, manualSync, authenticate, resolveConflict,
}
