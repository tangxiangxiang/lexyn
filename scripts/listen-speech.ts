import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { speechVoices, type SpeechVoice } from '../shared/contracts/speech.ts'
import { createSpeechCredentials } from '../server/speech/credentials.ts'
import { maxSpeechText, miniMaxProvider, SpeechError, synthesisRequest } from '../server/speech/provider.ts'

const [flag, voiceId, text, ...extra] = process.argv.slice(2)
if (flag !== '--paid' || !voiceId || !Object.hasOwn(speechVoices, voiceId)
  || !text?.trim() || text.length > maxSpeechText || /<#/.test(text) || extra.length) {
  console.error('Usage: node --env-file-if-exists=.env scripts/listen-speech.ts --paid <voice-id> "<text>"')
  process.exit(1)
}
try {
  const dataDir = resolve(process.env.LEXYN_DATA_DIR || 'data')
  const db = new Database(join(dataDir, 'lexyn.sqlite'), { readonly: true, fileMustExist: true })
  let apiKey: string | undefined
  try {
    const owner = db.prepare('SELECT id FROM owner').pluck().get() as string | undefined
    if (owner) apiKey = createSpeechCredentials(db, dataDir).read(owner)
  } finally { db.close() }
  const synthesize = miniMaxProvider(apiKey)
  const audio = await synthesize(synthesisRequest(text, voiceId as SpeechVoice))
  const path = join(await mkdtemp(join(tmpdir(), 'lexyn-listen-')), 'sample.mp3')
  await writeFile(path, audio, { mode: 0o600, flag: 'wx' })
  console.log(path)
} catch (error) {
  console.error(error instanceof SpeechError ? error.message : 'Could not read Lexyn speech settings or write the audio sample.')
  process.exitCode = 1
}
