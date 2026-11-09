<script setup lang="ts">
import { NAlert, NButton, NCard } from 'naive-ui'
import { formatReviewTime, useReviewOverview } from '../review/useReviewOverview'

const { data: overview, error, reload } = useReviewOverview(() => undefined)
</script>

<template>
  <section class="page progress-page">
    <header class="page-intro">
      <h1>Progress</h1>
      <p>See how your vocabulary grows over time.</p>
    </header>
    <NAlert v-if="error" type="error" role="alert">
      Your local progress could not be loaded. <NButton text @click="reload">Try again</NButton>
    </NAlert>
    <NCard v-else-if="overview" class="progress-card">
      <dl class="progress-stats">
        <div><dt>Learned for the first time today</dt><dd>{{ overview.learnedToday }}</dd></div>
        <div><dt>Reviews rated today</dt><dd>{{ overview.ratedToday }}</dd></div>
        <div><dt>Due reviews</dt><dd>{{ overview.due }}</dd></div>
        <div><dt>Waiting for first recall</dt><dd>{{ overview.firstRecall }}</dd></div>
      </dl>
      <p v-if="overview.nextDueAt !== undefined">
        Next review <time :datetime="new Date(overview.nextDueAt).toISOString()">{{ formatReviewTime(overview.nextDueAt) }}</time>
      </p>
      <p v-else class="library-muted">No upcoming reviews scheduled.</p>
    </NCard>
    <p v-else class="library-muted" aria-live="polite">Loading your progress…</p>
  </section>
</template>

<style scoped>
.progress-page { display: grid; gap: 16px; }
.progress-card { max-width: 760px; }
.progress-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap: 16px; margin-bottom: 16px; }
.progress-stats dd { margin: 4px 0 0; font-size: 1.5rem; font-weight: 650; }
</style>
