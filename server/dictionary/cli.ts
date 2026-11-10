import { resolve } from 'node:path'
import { lockDataDirectory } from '../db/database.ts'
import { importEcdictCsv } from './import.ts'

const path = process.argv[2]
if (!path) {
  console.error('Usage: npm run dictionary:import -- /path/to/ecdict.csv [source-commit-sha]')
  process.exitCode = 1
} else {
  const dataDir = resolve(process.env.LEXYN_DATA_DIR || 'data')
  const unlock = lockDataDirectory(dataDir)
  try {
    const result = await importEcdictCsv(dataDir, resolve(path), process.argv[3])
    console.log('ECDICT installed:', result.count, 'entries; SQLite bytes:', result.bytes, 'CSV SHA-256:', result.sha256)
  } finally { unlock() }
}
