import { resolve } from 'node:path'

export function readConfig(env: NodeJS.ProcessEnv) {
  const host = env.LEXYN_HOST || '127.0.0.1'
  const portText = env.LEXYN_PORT ?? '3000'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error('LEXYN_PORT must be an integer between 1 and 65535.')
  }

  const proxyHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  const urlHost = proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost

  return {
    host,
    port,
    origin: `http://${urlHost}:${port}`,
    dataDir: resolve(env.LEXYN_DATA_DIR || 'data'),
  }
}
