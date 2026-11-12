<script setup lang="ts">
import { t, useI18n } from '../i18n/useI18n'
import { computed, onMounted, onUnmounted } from 'vue'
import { darkTheme, NAlert, NButton, NConfigProvider, zhCN, dateZhCN, type GlobalThemeOverrides } from 'naive-ui'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'
import AuthPage from '../features/auth/AuthPage.vue'
import { closeSettings, settingsOrigin, settingsRoute } from '../features/settings/navigation'
import { provideAppearance } from '../ui/appearance'
import { checkSession, connection, refreshStudy, session, setupRequired } from '../api/client'
import { pwaUpdateWaiting } from '../pwa'

const { locale } = useI18n()
const { dark } = provideAppearance()
const route = useRoute()
const router = useRouter()
const settingsShell = computed(() => Boolean(session.value) && route.name === 'settings')
const settingsExit = computed(() => {
  if (!settingsShell.value) return '/study'
  const origin = settingsOrigin(router)
  return route.query.section ? settingsRoute(origin) : origin
})
const studyModes = [
  { path: '/study', title: 'Current book', icon: 'library' },
  { path: '/library', title: 'Library', icon: 'library' },
  { path: '/learn', title: 'Learn', icon: 'learn' },
  { path: '/review', title: 'Review', icon: 'review' },
  { path: '/progress', title: 'Progress', icon: 'progress' },
  { path: '/settings', title: 'Settings', icon: 'settings' },
] as const
const themeOverrides = computed<GlobalThemeOverrides>(() => settingsShell.value ? {
  common: {
    primaryColor: '#b8e3ff',
    primaryColorHover: '#d8efff',
    primaryColorPressed: '#99cdff',
    primaryColorSuppl: '#b8e3ff',
    borderRadius: '10px',
  },
  Input: {
    color: '#a6cdff1a',
    colorFocus: '#a6cdff26',
    border: '1px solid #b4d4ff38',
  },
} : {
  common: {
    primaryColor: dark.value ? '#a5d4b8' : '#285b47',
    primaryColorHover: dark.value ? '#bce4cb' : '#346f57',
    primaryColorPressed: dark.value ? '#8abfa1' : '#204c3a',
    primaryColorSuppl: dark.value ? '#a5d4b8' : '#285b47',
    borderRadius: '8px',
  },
  Card: {
    color: dark.value ? '#222822' : '#fffefa',
    borderColor: dark.value ? '#384138' : '#dedfd6',
    borderRadius: '16px',
    paddingMedium: '24px',
  },
})

const serviceStatus = computed(() => ({
  checking: 'Connecting', connected: 'Connected', unavailable: 'Connection unavailable',
  expired: 'Session expired', 'signed-out': setupRequired.value ? 'Setup required' : 'Signed out',
})[connection.value])
function onSettingsClose(event: MouseEvent) {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  closeSettings(router, settingsExit.value)
}
async function reconnect() {
  const previousOwner = session.value?.ownerId
  await checkSession()
  if (session.value?.ownerId === previousOwner && previousOwner && connection.value === 'connected') await refreshStudy()
}
const events = ['online', 'offline', 'focus'] as const
onMounted(() => {
  void reconnect()
  for (const event of events) window.addEventListener(event, reconnect)
})
onUnmounted(() => {
  for (const event of events) window.removeEventListener(event, reconnect)
})
</script>

<template>
  <NConfigProvider :theme="dark || settingsShell ? darkTheme : null" :theme-overrides="themeOverrides"
    :locale="locale === 'zh' ? zhCN : undefined" :date-locale="locale === 'zh' ? dateZhCN : undefined">
    <AuthPage v-if="!session" :dark="dark" :service-status="t(serviceStatus)" @retry="reconnect" />
    <div v-else class="app-shell" :class="{ 'reader-shell': route.name === 'library-deck', 'settings-shell': settingsShell }" :data-theme="dark ? 'dark' : 'light'">
      <a class="skip-link" href="#main">{{ t('Skip to content') }}</a>
      <header class="app-header">
        <RouterLink class="brand" to="/study" :aria-label="t('Lexyn home')">
          <img src="/favicon.svg" width="36" height="36" alt="">
          <span>Lexyn</span>
        </RouterLink>
        <nav :aria-label="t('Main navigation')">
          <RouterLink v-if="settingsShell" v-slot="{ href }" :to="settingsExit" custom>
            <a class="icon-control" :href="href" :aria-label="t('Close')" @click="onSettingsClose">
              <AppIcon :name="route.query.section ? 'chevronLeft' : 'close'" />
            </a>
          </RouterLink>
          <details v-else class="app-menu" @keydown.esc.stop="($event.currentTarget as HTMLDetailsElement).open = false">
            <summary class="icon-control" :aria-label="t('Menu')"><AppIcon name="menu" /></summary>
            <div class="app-menu-links">
              <RouterLink v-for="mode in studyModes" :key="mode.path"
                :to="mode.path === '/settings' ? settingsRoute(route.fullPath) : mode.path"
                @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">
                <AppIcon :name="mode.icon" />
                <span>{{ t(mode.title) }}</span>
              </RouterLink>
              <div v-if="$route.name === 'library-deck'" id="reader-menu-actions"></div>
            </div>
          </details>
        </nav>
      </header>
      <div class="main-column">
        <p v-if="pwaUpdateWaiting" class="update-notice">{{ t('New version available. Finish your work, then close all Lexyn tabs and reopen.') }}</p>
        <main id="main" class="main" tabindex="-1">
          <NAlert v-if="connection === 'unavailable'" type="error" role="alert">
            {{ t('Cannot connect to Lexyn. Connect to the server to load and save your work.') }}
            <NButton text @click="reconnect">{{ t('Retry connection') }}</NButton>
          </NAlert>
          <RouterView :key="session.ownerId" />
        </main>
      </div>
    </div>
  </NConfigProvider>
</template>
