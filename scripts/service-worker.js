// version and precache are injected from the production build.
const prefix = 'lexyn-shell-'
const cacheName = prefix + version

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    const downloads = await Promise.allSettled(Object.entries(precache).map(async ([path, { mime, sha256 }]) => {
      const response = await fetch(path, { credentials: 'omit', redirect: 'error', cache: 'no-store' })
      if (!response.ok || !response.headers.get('content-type')?.includes(mime)) {
        throw new Error(`Invalid application resource: ${path}`)
      }
      const hash = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer())
      const actual = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
      if (actual !== sha256) throw new Error(`Mismatched application resource: ${path}`)
      await cache.put(path, response)
    }))
    if (downloads.some((download) => download.status === 'rejected')) {
      await caches.delete(cacheName)
      throw new Error('The Lexyn application shell could not be installed.')
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(prefix) && key !== cacheName).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const { origin, pathname } = new URL(request.url)
  if (request.method !== 'GET' || origin !== self.location.origin || pathname === '/api' || pathname.startsWith('/api/')) return
  let path
  if (Object.hasOwn(precache, pathname)) path = pathname
  else if (request.mode === 'navigate' && /^(?:\/|\/(?:library|learn|review|progress|settings)\/?|\/library\/[0-9a-f-]+\/?)$/.test(pathname)) {
    path = '/index.html'
  }
  if (!path) return
  event.respondWith(caches.open(cacheName).then(async (cache) => await cache.match(path) ?? fetch(request)))
})
