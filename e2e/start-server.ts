import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initializeOwner } from '../server/auth/owner.ts'
import { readConfig } from '../server/config/env.ts'
import { openDatabase } from '../server/db/database.ts'

const password = process.env.LEXYN_TEST_OWNER_PASSWORD
if (!password) throw new Error('Playwright Owner password is missing.')
const database = openDatabase(readConfig(process.env).dataDir)
try {
  await initializeOwner(database, password)
} finally {
  database.close()
}
await import(pathToFileURL(resolve('dist-server/server/index.js')).href)
