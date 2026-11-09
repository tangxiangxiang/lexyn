import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { readConfig } from './config/env.ts'
import { openDatabase } from './db/database.ts'

const config = readConfig(process.env)
const db = openDatabase(config.dataDir)
const webRoot = import.meta.url.endsWith('.js') ? resolve('dist') : undefined
const app = createApp(db, webRoot)
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`Lexyn API ready at ${config.origin}/api/health`)
})

function shutdown() {
  server.close(() => db.close())
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
