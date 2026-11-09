import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const host = '127.0.0.1'
const port = '4173'
const baseURL = `http://${host}:${port}`
const dataDir = process.env.LEXYN_TEST_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'lexyn-playwright-'))
const password = process.env.LEXYN_TEST_OWNER_PASSWORD ??= randomBytes(24).toString('base64url')

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/start-server.ts',
    url: `${baseURL}/api/health`,
    env: {
      LEXYN_HOST: host,
      LEXYN_PORT: port,
      LEXYN_DATA_DIR: dataDir,
      LEXYN_PUBLIC_ORIGIN: baseURL,
      LEXYN_TEST_OWNER_PASSWORD: password,
    },
  },
})
