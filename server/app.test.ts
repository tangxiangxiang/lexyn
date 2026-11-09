import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { createApp } from './app.ts'
import { migrate } from './db/migrations/index.ts'

test('reports healthy SQLite without exposing database details', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    const response = await createApp(db).request('/api/health')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' })
  } finally {
    db.close()
  }
})

test('reports unavailable when SQLite cannot be queried', async () => {
  const db = new Database(':memory:')
  db.close()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await createApp(db).request('/api/health')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'unavailable', database: 'unavailable' })
    expect(log).toHaveBeenCalledOnce()
  } finally {
    log.mockRestore()
  }
})
