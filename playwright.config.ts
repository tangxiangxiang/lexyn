import { defineConfig } from '@playwright/test'

const host = '127.0.0.1'
const port = '4173'
const baseURL = `http://${host}:${port}`

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: `${baseURL}/api/health`,
    env: {
      LEXYN_HOST: host,
      LEXYN_PORT: port,
      LEXYN_DATA_DIR: './data/playwright',
    },
  },
})
