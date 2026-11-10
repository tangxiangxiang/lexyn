import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { developmentWebPort, readConfig } from './server/config/env.ts'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  server: command === 'serve'
    ? { host: '127.0.0.1', port: developmentWebPort, strictPort: true, proxy: { '/api': { target: readConfig(process.env).origin } } }
    : undefined,
}))
