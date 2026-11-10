import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { readConfig } from './config/env.ts'
import { lockDataDirectory, openDatabase } from './db/database.ts'

const development = import.meta.url.endsWith('.ts') && process.env.NODE_ENV !== 'production'
const config = readConfig(development ? { LEXYN_PUBLIC_ORIGIN: 'http://127.0.0.1:5173', ...process.env } : process.env)
const unlock = lockDataDirectory(config.dataDir)
const db = openDatabase(config.dataDir)
const webRoot = import.meta.url.endsWith('.js') ? resolve('dist') : undefined
const app = createApp(db, webRoot, config.publicOrigin)
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`Lexyn API ready at ${config.origin}/api/health`)
})

function shutdown() {
  server.close(() => {
    try { db.close() } finally { unlock() }
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
