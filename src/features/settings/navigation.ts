import type { RouteLocationRaw, Router } from 'vue-router'

export function settingsRoute(origin: string, section?: string): RouteLocationRaw {
  return { name: 'settings', query: { section }, state: { settingsOrigin: origin } }
}

export function settingsOrigin(router: Router): string {
  const origin = router.options.history.state.settingsOrigin
  if (typeof origin !== 'string' || !origin.startsWith('/') || origin.startsWith('//')) return '/study'
  return router.resolve(origin).name === 'settings' ? '/study' : origin
}

export function closeSettings(router: Router, to: RouteLocationRaw) {
  if (router.options.history.state.back === router.resolve(to).fullPath) router.back()
  else void router.replace(to)
}
