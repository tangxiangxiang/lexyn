import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { readConfig } from '../config/env.ts'
import { openDatabase } from '../db/database.ts'
import { initializeOwner } from './owner.ts'
import { normalizeUsername } from './password.ts'

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 1024) throw new Error('Password input is too large.')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  const hidden = new Writable({ write(_chunk, _encoding, done) { done() } })
  const input = createInterface({ input: process.stdin, output: hidden, terminal: true })
  try {
    process.stderr.write('Owner password: ')
    const password = await input.question('')
    process.stderr.write('\nRepeat password: ')
    const repeat = await input.question('')
    process.stderr.write('\n')
    if (password !== repeat) throw new Error('The passwords did not match.')
    return password
  } finally {
    input.close()
  }
}

try {
  const [username, ...extra] = process.argv.slice(2)
  if (!username || extra.length) throw new Error('Usage: npm run owner:init -- <username>')
  const normalized = normalizeUsername(username)
  const config = readConfig(process.env)
  const password = await readPassword()
  const db = openDatabase(config.dataDir)
  try {
    await initializeOwner(db, normalized, password)
    console.log('Owner initialized.')
  } finally {
    db.close()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Owner initialization failed.')
  process.exitCode = 1
}
