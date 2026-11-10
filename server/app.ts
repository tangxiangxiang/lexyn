import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createAuthApi } from './auth/routes.ts'
import { syncRoutes } from './sync/routes.ts'
import { healthRoutes } from './routes/health.ts'

export function createApp(db: Database.Database, webRoot?: string, publicOrigin = 'http://127.0.0.1:3000') {
  const app = new Hono()
  app.onError((_error, c) => {
    console.error('Request failed')
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }, 500)
  })
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404))

  const auth = createAuthApi(db, publicOrigin)
  app.route('/api/auth', auth.routes)
  app.route('/api', healthRoutes(db))
  app.route('/api', syncRoutes(db, auth))
  app.all('/api/*', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.notFound()
  })

  if (webRoot) {
    const index = readFileSync(join(webRoot, 'index.html'), 'utf8')
    app.use('/assets/*', serveStatic({ root: webRoot, onFound: (_path, c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
    } }))
    for (const path of ['/manifest.webmanifest', '/sw.js', '/favicon.svg', '/pwa-192.png', '/pwa-512.png', '/pwa-512-maskable.png']) {
      app.use(path, serveStatic({ root: webRoot, onFound: (_file, c) => { c.header('Cache-Control', 'no-cache') } }))
    }
    app.get('/index.html', (c) => c.html(index, 200, { 'Cache-Control': 'no-cache' }))
    app.get('*', (c) => {
      const path = c.req.path
      if (path === '/assets' || path.startsWith('/assets/') || extname(path)) return c.notFound()
      return c.html(index, 200, { 'Cache-Control': 'no-cache' })
    })
  }

  return app
}
