import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { readConfig } from './server/config/env.ts'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  server: command === 'serve'
    ? { proxy: { '/api': { target: readConfig(process.env).origin } } }
    : undefined,
}))
