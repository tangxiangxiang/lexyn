import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import type { HealthResponse } from '../../shared/contracts/health.ts'

export function healthRoutes(db: Database.Database) {
  return new Hono().get('/health', (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      db.prepare('SELECT id FROM owner LIMIT 1').get()
      return c.json<HealthResponse>({ status: 'ok', database: 'ok' })
    } catch (error) {
      console.error('SQLite health check failed', error)
      return c.json<HealthResponse>({ status: 'unavailable', database: 'unavailable' }, 503)
    }
  })
}
