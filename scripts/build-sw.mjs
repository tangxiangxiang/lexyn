import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../dist/', import.meta.url)
const worker = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')
const staticFiles = ['index.html', 'manifest.webmanifest', 'favicon.svg', 'pwa-192.png', 'pwa-512.png', 'pwa-512-maskable.png']
const types = { '.html': 'text/html', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.js': 'javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const assets = readdirSync(new URL('assets/', root), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && Object.hasOwn(types, extname(entry.name)))
  .map((entry) => relative(fileURLToPath(root), join(entry.parentPath, entry.name)).split(sep).join('/')).sort()
const hash = createHash('sha256').update(worker)
const precache = Object.fromEntries([...staticFiles, ...assets].map((path) => {
  const sha256 = createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')
  hash.update(path).update(sha256)
  return [`/${path}`, { mime: types[extname(path)], sha256 }]
}))
writeFileSync(new URL('sw.js', root), `const version = ${JSON.stringify(hash.digest('hex'))}\nconst precache = ${JSON.stringify(precache)}\n${worker}`)
