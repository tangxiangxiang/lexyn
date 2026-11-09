import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { healthRoutes } from './routes/health.ts'

export function createApp(db: Database.Database, webRoot?: string) {
  const app = new Hono()
  app.onError((error, c) => {
    console.error('Request failed', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }, 500)
  })
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404))

  app.route('/api', healthRoutes(db))
  app.all('/api/*', (c) => c.notFound())

  if (webRoot) {
    const index = readFileSync(join(webRoot, 'index.html'), 'utf8')
    app.use('/assets/*', serveStatic({ root: webRoot }))
    app.use('/favicon.svg', serveStatic({ root: webRoot }))
    app.get('*', (c) => {
      const path = c.req.path
      if (path === '/assets' || path.startsWith('/assets/') || extname(path)) return c.notFound()
      return c.html(index, 200, { 'Cache-Control': 'no-cache' })
    })
  }

  return app
}
