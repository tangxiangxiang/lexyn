<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { darkTheme, NConfigProvider, type GlobalThemeOverrides } from 'naive-ui'
import { RouterLink, RouterView } from 'vue-router'
import type { HealthResponse } from '../../shared/contracts/health'
import AppIcon from '../components/AppIcon.vue'
import { navigation } from '../router'
import { provideAppearance } from '../ui/appearance'

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

const serviceStatus = ref<'Connecting' | 'Service ready' | 'Service unavailable'>('Connecting')
onMounted(async () => {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(4000) })
    if (!response.ok) throw new Error('Health check failed.')
    const health: HealthResponse = await response.json()
    serviceStatus.value = health.status === 'ok' && health.database === 'ok'
      ? 'Service ready'
      : 'Service unavailable'
  } catch {
    serviceStatus.value = 'Service unavailable'
  }
})
</script>

<template>
  <NConfigProvider :theme="dark ? darkTheme : null" :theme-overrides="themeOverrides">
    <div class="app-shell" :data-theme="dark ? 'dark' : 'light'">
      <a class="skip-link" href="#main">Skip to content</a>
      <aside class="sidebar">
        <RouterLink class="brand" to="/library" aria-label="Lexyn home">
          <img src="/favicon.svg" width="36" height="36" alt="">
          <span>Lexyn</span>
        </RouterLink>
        <nav class="nav" aria-label="Main navigation">
          <RouterLink v-for="item in navigation" :key="item.path" :to="item.path"
            :class="{ 'nav-section-active': item.path === '/library' && $route.name === 'library-deck' }">
            <AppIcon :name="item.icon" />
            <span>{{ item.title }}</span>
          </RouterLink>
        </nav>
        <p class="sidebar-note">Learn. Recall. Retain.</p>
      </aside>
      <div class="main-column">
        <header class="topbar">
          <span class="topbar-label">Vocabulary studio</span>
          <span class="service-status" role="status" :data-status="serviceStatus">{{ serviceStatus }}</span>
        </header>
        <main id="main" class="main" tabindex="-1">
          <RouterView />
        </main>
      </div>
    </div>
  </NConfigProvider>
</template>
