import { resolve } from 'node:path'
import { lockDataDirectory } from '../db/database.ts'
import { importEcdictCsv } from './import.ts'

import { cefrSources, importCefr } from './classification.ts'

const [mode, source, input, version] = process.argv.slice(2)
const path = mode === 'cefr' ? input : mode
if (!path || (mode === 'cefr' && (!source || !version))) {
  console.error('Usage: npm run dictionary:import -- /path/to/ecdict.csv [source-commit-sha]')
  console.error('       npm run dictionary:import -- cefr <cefr-j|octanove> /path/to/profile.csv <version>')
  process.exitCode = 1
} else {
  const dataDir = resolve(process.env.LEXYN_DATA_DIR || 'data')
  const unlock = lockDataDirectory(dataDir)
  try {
    if (mode === 'cefr') {
      const result = importCefr(dataDir, resolve(path), source as keyof typeof cefrSources, version!)
      console.log(result.name, result.version, result.wordCount, 'headwords; CSV SHA-256:', result.sha256)
    } else {
      const result = await importEcdictCsv(dataDir, resolve(path), source)
      console.log('ECDICT installed:', result.count, 'entries; SQLite bytes:', result.bytes, 'CSV SHA-256:', result.sha256)
    }
  } finally { unlock() }
}
