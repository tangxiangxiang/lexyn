<script setup lang="ts">
import { t } from '../i18n/useI18n'
import { NButton, NCard } from 'naive-ui'
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'
import type { IconName } from '../ui/icons'

defineProps<{
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  icon: IconName
  recovery?: boolean
}>()
</script>

<template>
  <section class="page">
    <header class="page-intro">
      <h1>{{ t(title) }}</h1>
      <p>{{ t(description) }}</p>
    </header>
    <NCard class="empty-card">
      <div class="empty-content">
        <span class="empty-icon"><AppIcon :name="icon" /></span>
        <h2>{{ t(emptyTitle) }}</h2>
        <p>{{ t(emptyDescription) }}</p>
        <RouterLink v-if="recovery" to="/library" custom v-slot="{ href, navigate }">
          <NButton tag="a" :href="href" type="primary" @click="navigate">{{ t('Back to Library') }}</NButton>
        </RouterLink>
      </div>
    </NCard>
  </section>
</template>
