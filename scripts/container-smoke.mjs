import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer, request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const image = process.argv[2]
if (!image) throw new Error('Pass the image to verify.')
const temp = mkdtempSync(join(tmpdir(), 'lexyn-container-test-'))
const name = `lexyn-smoke-${randomUUID()}`
const volume = `${name}-data`
const password = randomBytes(24).toString('base64url')
const key = join(temp, 'key.pem')
const cert = join(temp, 'cert.pem')
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options }).trim()
let backendPort
let proxy
let origin

function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const headers = { 'X-Lexyn-Client': '1', ...options.headers }
    if (body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    const outgoing = httpsRequest(new URL(path, origin), {
      ca: readFileSync(cert), method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const bytes = Buffer.concat(chunks)
        resolve({ status: response.statusCode, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString()) })
      })
      response.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Smoke request timed out.')))
    outgoing.end(body)
  })
}

function start() {
  docker(['run', '-d', '--platform', 'linux/amd64', '--name', name, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp', '-p', '127.0.0.1::3000', '-v', `${volume}:/var/lib/lexyn`,
    '-e', `LEXYN_PUBLIC_ORIGIN=${origin}`, image])
  updatePort()
}

function updatePort() {
  backendPort = Number(docker(['port', name, '3000/tcp']).split(':').at(-1))
}

async function healthy() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await api('/api/health')
      if (response.status === 200 && response.json().database === 'ok') return
    } catch { /* startup still in progress */ }
    await delay(500)
  }
  console.error(docker(['logs', '--tail', '15', name]))
  throw new Error('The container did not become healthy.')
}

try {
  assert.equal(docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]), 'linux/amd64')
  assert.equal(docker(['image', 'inspect', '--format', '{{.Config.User}}', image]), 'node')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  proxy = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, response) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: incoming.url,
      method: incoming.method, headers: { ...incoming.headers, 'x-forwarded-host': 'ignored.invalid', 'x-forwarded-proto': 'https' },
    }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    upstream.on('error', () => { response.writeHead(502); response.end() })
    incoming.pipe(upstream)
  })
  await new Promise((resolve) => proxy.listen(0, resolve))
  origin = `https://localhost:${proxy.address().port}`
  docker(['volume', 'create', volume])
  start()
  await healthy()
  assert.equal(docker(['exec', name, 'id', '-u']), '1000')
  docker(['exec', '-i', name, 'npm', 'run', '--silent', 'owner:init:production'], { input: `${password}\n` })
  assert.equal((await api('/api/sync/pull')).status, 401)
  const session = await api('/api/auth/login', { body: { password } })
  assert.equal(session.status, 200)
  const cookie = session.headers['set-cookie'][0]
  assert.match(cookie, /^__Host-lexyn-session=/)
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attribute))
  const headers = { Cookie: cookie.split(';')[0], 'X-Lexyn-Owner': session.json().session.ownerId }
  const crossOrigin = await api('/api/auth/session', { headers: { Origin: 'https://elsewhere.invalid' } })
  assert.equal(crossOrigin.status, 403)
  const deckId = randomUUID()
  const now = Date.now()
  const push = await api('/api/sync/push', { headers, body: { schemaVersion: 1, deviceId: randomUUID(), cursor: 0,
    operations: [{ opId: randomUUID(), schemaVersion: 1, entityId: deckId, kind: 'deck.create', baseRevision: 0, sequence: 1,
      createdAt: now, payload: { id: deckId, name: 'Container smoke', revision: 1, createdAt: now, updatedAt: now } }] } })
  assert.equal(push.status, 200)
  assert.equal(push.json().results[0].status, 'accepted')
  const verifyDeck = async () => {
    const bootstrap = await api('/api/bootstrap', { headers })
    assert.equal(bootstrap.status, 200)
    assert.equal(bootstrap.json().changes[0].record.value.id, deckId)
  }
  await verifyDeck()
  const snapshot = JSON.parse(docker(['exec', name, 'npm', 'run', '--silent', 'backup:create']))
  const verified = JSON.parse(docker(['exec', name, 'npm', 'run', '--silent', 'backup:verify', '--', snapshot.directory]))
  assert.equal(verified.sha256, snapshot.sha256)
  for (const [path, type] of [['/library', 'text/html'], ['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'javascript'],
    ['/favicon.svg', 'image/svg+xml'], ['/pwa-192.png', 'image/png'], ['/pwa-512.png', 'image/png'], ['/pwa-512-maskable.png', 'image/png']]) {
    const result = await api(path)
    assert.equal(result.status, 200, path)
    assert.ok(result.headers['content-type'].includes(type), path)
    assert.equal(result.headers.location, undefined, path)
    assert.equal(result.headers['cache-control'], 'no-cache', path)
    if (path.endsWith('.png')) assert.equal(result.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    if (path.endsWith('.webmanifest')) assert.equal(result.json().display, 'standalone')
    if (path === '/sw.js') assert.match(result.bytes.toString(), /lexyn-shell-/)
  }
  assert.equal((await api('/assets/absent.js')).status, 404)
  docker(['restart', name])
  updatePort()
  await healthy()
  await verifyDeck()
  docker(['stop', name])
  docker(['rm', name])
  start()
  await healthy()
  await verifyDeck()
  assert.equal(JSON.parse(docker(['exec', name, 'npm', 'run', '--silent', 'backup:verify', '--', snapshot.directory])).sha256, snapshot.sha256)
  console.log('Linux amd64 production image passed TLS proxy, authenticated sync, static PWA, backup, restart and volume recreation checks.')
} finally {
  proxy?.close()
  try { docker(['rm', '-f', name], { stdio: 'ignore' }) } catch { /* already removed */ }
  try { docker(['volume', 'rm', volume], { stdio: 'ignore' }) } catch { /* not created */ }
  rmSync(temp, { recursive: true, force: true })
}
