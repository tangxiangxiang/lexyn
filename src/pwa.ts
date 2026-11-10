import { ref } from 'vue'

export const pwaUpdateWaiting = ref(false)

export async function registerPwa() {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    const reportUpdate = () => { pwaUpdateWaiting.value = Boolean(registration.waiting && navigator.serviceWorker.controller) }
    const watchInstalling = () => registration.installing?.addEventListener('statechange', reportUpdate)
    registration.addEventListener('updatefound', watchInstalling)
    watchInstalling()
    reportUpdate()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => {})
    })
  } catch {
    // The application is still available as an ordinary website.
  }
}
