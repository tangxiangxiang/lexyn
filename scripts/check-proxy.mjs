const origin = process.argv[2]
let url
try { url = new URL(origin) } catch { /* handled below */ }
if (!url || url.protocol !== 'https:' || url.origin !== origin) throw new Error('Pass the exact external HTTPS origin.')

const png = (response) => response.arrayBuffer().then((data) => Buffer.from(data).subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
const checks = [
  ['/manifest.webmanifest', 'application/manifest+json', 'no-cache', async (r) => (await r.json()).name === 'Lexyn'],
  ['/sw.js', 'javascript', 'no-cache', async (r) => (await r.text()).includes('lexyn-shell-')],
  ['/favicon.svg', 'image/svg+xml', 'no-cache', async (r) => (await r.text()).trimStart().startsWith('<svg')],
  ['/pwa-192.png', 'image/png', 'no-cache', png], ['/pwa-512.png', 'image/png', 'no-cache', png],
  ['/pwa-512-maskable.png', 'image/png', 'no-cache', png],
  ['/api/health', 'application/json', 'no-store', async (r) => {
    const body = await r.json()
    return body.status === 'ok' && body.database === 'ok'
  }],
  ...['/', '/library', '/learn', '/review', '/settings'].map((path) => [path, 'text/html', 'no-cache', async (r) => (await r.text()).includes('id="app"')]),
]
for (const [path, mime, cache, checkBody] of checks) {
  try {
    const response = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    const type = response.headers.get('content-type') ?? ''
    const cacheControl = response.headers.get('cache-control') ?? ''
    const location = response.headers.get('location')
    // Only record the redirect destination's origin/path, never any query or user information.
    const destination = location ? new URL(location, origin) : null
    const bodyOk = Boolean(type.includes(mime) && await checkBody(response).catch(() => false))
    const valid = response.status === 200 && !location && cacheControl.includes(cache) && bodyOk
    console.log(`${valid ? 'OK' : 'FAIL'} ${path} HTTP ${response.status} Content-Type=${type || '(missing)'} Cache-Control=${cacheControl || '(missing)'} Location=${destination ? destination.origin + destination.pathname : '(none)'} Body=${bodyOk ? 'valid' : 'invalid'}`)
    if (!valid) process.exitCode = 1
  } catch {
    console.error(`FAIL ${path} HTTPS connection or response failed.`)
    process.exitCode = 1
  }
}
