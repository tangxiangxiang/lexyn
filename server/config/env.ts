import { resolve } from 'node:path'

export const developmentWebPort = 5173

export function readConfig(env: NodeJS.ProcessEnv, serveVite = false) {
  const host = env.LEXYN_HOST || '127.0.0.1'
  const portText = env.LEXYN_PORT ?? '3000'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error('LEXYN_PORT must be an integer between 1 and 65535.')
  }

  const proxyHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  const urlHost = proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost

  const origin = `http://${urlHost}:${port}`
  const production = env.NODE_ENV === 'production'
  const useViteDefault = serveVite && !production && !env.LEXYN_PUBLIC_ORIGIN
  const publicOrigin = env.LEXYN_PUBLIC_ORIGIN
    || (production ? '' : useViteDefault ? `http://127.0.0.1:${developmentWebPort}` : origin)
  let url: URL
  try {
    url = new URL(publicOrigin)
  } catch {
    throw new Error('Set LEXYN_PUBLIC_ORIGIN to the application origin.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== publicOrigin || (url.protocol !== 'https:' && (production || !loopback || url.protocol !== 'http:'))) {
    throw new Error('LEXYN_PUBLIC_ORIGIN must be an HTTPS origin, or a loopback HTTP origin in development.')
  }
  return {
    host,
    port,
    origin,
    publicOrigin,
    additionalOrigins: useViteDefault ? [`http://localhost:${developmentWebPort}`] : [],
    dataDir: resolve(env.LEXYN_DATA_DIR || 'data'),
  }
}
