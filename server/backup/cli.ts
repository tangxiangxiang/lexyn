import { resolve } from 'node:path'
import { readConfig } from '../config/env.ts'
import { lockDataDirectory, openDatabase } from '../db/database.ts'
import { readLibraryBackup, restoreLibrary } from './library.ts'
import { createSqliteBackup, restoreSqliteBackup, verifySqliteBackup } from './sqlite.ts'

process.umask(0o077)
const [command, path, confirmation, ...extra] = process.argv.slice(2)
try {
  if (extra.length) throw new Error('Unexpected backup arguments.')
  if (command === 'create' && !confirmation) {
    const { dataDir } = readConfig(process.env)
    console.log(JSON.stringify(await createSqliteBackup(dataDir, resolve(path || process.env.LEXYN_BACKUP_DIR || 'backups'))))
  } else if (command === 'verify' && path && !confirmation) {
    console.log(JSON.stringify(await verifySqliteBackup(resolve(path))))
  } else if (command === 'restore' && path && confirmation === '--confirm-stopped') {
    console.log(JSON.stringify(await restoreSqliteBackup(readConfig(process.env).dataDir, resolve(path))))
  } else if (command === 'restore-json' && path && confirmation === '--confirm-empty') {
    const plan = await readLibraryBackup(resolve(path))
    const { dataDir } = readConfig(process.env)
    const unlock = lockDataDirectory(dataDir)
    try {
      const db = openDatabase(dataDir)
      try { restoreLibrary(db, plan) } finally { db.close() }
    } finally { unlock() }
    console.log(`Restored ${plan.backup.decks.length} decks, ${plan.backup.entries.length} entries, ${plan.backup.practiceEvents.length} practice events and ${plan.backup.reviewEvents.length} review events.`)
  } else {
    throw new Error('Use create [directory], verify <backup directory>, restore <backup directory> --confirm-stopped, or restore-json <file> --confirm-empty.')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup operation failed.')
  process.exitCode = 1
}
