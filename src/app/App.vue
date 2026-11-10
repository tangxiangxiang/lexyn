<script setup lang="ts">
import { t, useI18n } from '../i18n/useI18n'
import { computed, onMounted, onUnmounted } from 'vue'
import { darkTheme, NAlert, NButton, NConfigProvider, zhCN, dateZhCN, type GlobalThemeOverrides } from 'naive-ui'
import { RouterLink, RouterView } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'
import AuthPage from '../features/auth/AuthPage.vue'
import { navigation } from '../router'
import { provideAppearance } from '../ui/appearance'
import { checkSession, connection, refreshStudy, session, setupRequired } from '../api/client'
import { pwaUpdateWaiting } from '../pwa'

const { locale } = useI18n()
const { dark } = provideAppearance()
const themeOverrides = computed<GlobalThemeOverrides>(() => ({
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
}))

const serviceStatus = computed(() => ({
  checking: 'Connecting', connected: 'Connected', unavailable: 'Connection unavailable',
  expired: 'Session expired', 'signed-out': setupRequired.value ? 'Setup required' : 'Signed out',
})[connection.value])
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
  <NConfigProvider :theme="dark ? darkTheme : null" :theme-overrides="themeOverrides"
    :locale="locale === 'zh' ? zhCN : undefined" :date-locale="locale === 'zh' ? dateZhCN : undefined">
    <AuthPage v-if="!session" :dark="dark" :service-status="t(serviceStatus)" @retry="reconnect" />
    <div v-else class="app-shell" :data-theme="dark ? 'dark' : 'light'">
      <a class="skip-link" href="#main">{{ t('Skip to content') }}</a>
      <aside class="sidebar">
        <RouterLink class="brand" to="/library" :aria-label="t('Lexyn home')">
          <img src="/favicon.svg" width="36" height="36" alt="">
          <span>Lexyn</span>
        </RouterLink>
        <nav class="nav" :aria-label="t('Main navigation')">
          <RouterLink v-for="item in navigation" :key="item.path" :to="item.path"
            :class="{ 'nav-section-active': item.path === '/library' && $route.name === 'library-deck' }">
            <AppIcon :name="item.icon" />
            <span>{{ t(item.title) }}</span>
          </RouterLink>
        </nav>
        <p class="sidebar-note">{{ t('Learn. Recall. Retain.') }}</p>
      </aside>
      <div class="main-column">
        <header class="topbar">
          <span class="topbar-label">{{ t('Vocabulary studio') }}</span>
          <span class="service-status" role="status" :data-status="serviceStatus">
            {{ t(serviceStatus) }}
          </span>
        </header>
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
