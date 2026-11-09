import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type Database from 'better-sqlite3'
import { PULL_LIMIT, PUSH_LIMIT, SYNC_VERSION, type PushResult } from '../../shared/contracts/sync.ts'
import { createReviewScheduler, schedulerConfigSnapshot } from '../../shared/srs/scheduler.ts'
import { apiError, type AuthEnv, type createAuthApi } from '../auth/routes.ts'
import { createSyncRepository } from './repository.ts'
import { InvalidOperation, integer, isUuid, object, validateOperation } from './validation.ts'

function queryInteger(value: string | undefined, fallback?: number) {
  if (value === undefined) return fallback
  return /^\d+$/.test(value) && integer(Number(value)) ? Number(value) : NaN
}

export function syncRoutes(db: Database.Database, auth: ReturnType<typeof createAuthApi>) {
  const routes = new Hono<AuthEnv>()
  const sync = createSyncRepository(db)
  let config: ReturnType<typeof createReviewScheduler> | undefined

  routes.use('/bootstrap', auth.guardOrigin, auth.requireOwner)
  routes.use('/sync/*', auth.guardOrigin, auth.requireOwner)
  for (const path of ['/bootstrap', '/sync/pull'] as const) {
    routes.get(path, (c) => {
      const after = queryInteger(c.req.query('after'), 0)!
      const through = path === '/bootstrap' ? queryInteger(c.req.query('through')) : undefined
      const limit = queryInteger(c.req.query('limit'), PULL_LIMIT)!
      if (!integer(after) || !integer(limit, 1, PULL_LIMIT) || (through !== undefined && !integer(through))
        || (path === '/bootstrap' && after > 0 && through === undefined)) {
        return apiError(c, 400, 'CURSOR', 'The synchronization page parameters are invalid.')
      }
      const page = sync.page(c.get('ownerId'), after, limit, through)
      if (!page) return apiError(c, 409, 'CURSOR', 'This cursor does not exist on the server.')
      return c.json(page)
    })
  }
  routes.post('/sync/push', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    let input: Record<string, unknown>
    try {
      if (c.req.header('Content-Type')?.split(';')[0] !== 'application/json') throw new InvalidOperation()
      input = object(await c.req.json())
    } catch {
      return apiError(c, 400, 'PAYLOAD', 'Expected a JSON synchronization batch.')
    }
    if (Object.keys(input).some((key) => !['schemaVersion', 'deviceId', 'cursor', 'operations'].includes(key))
      || input.schemaVersion !== SYNC_VERSION || !isUuid(input.deviceId) || !integer(input.cursor, 0, sync.watermark())
      || !Array.isArray(input.operations) || input.operations.length > PUSH_LIMIT) {
      return apiError(c, 400, 'PAYLOAD', 'The synchronization batch is invalid.')
    }
    const envelope = input.operations as unknown[]
    const ids = new Set<string>()
    let previous = 0
    for (const operation of envelope) {
      try {
        const { opId, sequence } = object(operation)
        if (!isUuid(opId) || ids.has(opId) || !integer(sequence, previous + 1)) throw new InvalidOperation()
        ids.add(opId)
        previous = sequence
      } catch {
        return apiError(c, 400, 'ORDER', 'Operations need distinct IDs and ascending local sequence.')
      }
    }
    sync.registerDevice(input.deviceId, c.get('ownerId'), input.cursor)
    const results: PushResult[] = []
    for (const operation of envelope) {
      const item = object(operation)
      let op
      try {
        const snapshot = item.kind === 'review.create'
          ? schedulerConfigSnapshot(await (config ??= createReviewScheduler().catch((error) => { config = undefined; throw error })))
          : undefined
        op = validateOperation(item, snapshot)
      } catch (error) {
        if (!(error instanceof InvalidOperation || error instanceof RangeError)) throw error
        results.push({ opId: item.opId as string, status: 'rejected', reason: error.message || 'Invalid operation.' })
        continue
      }
      results.push(await sync.push(op, input.deviceId))
    }
    return c.json({ schemaVersion: SYNC_VERSION, results }, results.length === 1 && results[0].status === 'conflict' ? 409 : 200)
  })
  return routes
}
