<script setup lang="ts">
import { t } from '../../i18n/useI18n'
import { NAlert, NButton, NCard } from 'naive-ui'
import { formatReviewTime, useReviewOverview } from '../review/useReviewOverview'

const { data: overview, error, reload } = useReviewOverview(() => undefined, true)
</script>

<template>
  <section class="page progress-page">
    <header class="page-intro">
      <h1>{{ t('Progress') }}</h1>
      <p>{{ t('See how your vocabulary grows over time.') }}</p>
    </header>
    <NAlert v-if="error" type="error" role="alert">
      {{ t('Your progress could not be loaded from the server.') }} <NButton text @click="reload">{{ t('Try again') }}</NButton>
    </NAlert>
    <NCard v-else-if="overview" class="progress-card">
      <dl class="progress-stats">
        <div><dt>{{ t('Learned for the first time today') }}</dt><dd>{{ overview.learnedToday }}</dd></div>
        <div><dt>{{ t('Reviews rated today') }}</dt><dd>{{ overview.ratedToday }}</dd></div>
        <div><dt>{{ t('Due reviews') }}</dt><dd>{{ overview.due }}</dd></div>
        <div><dt>{{ t('Waiting for first recall') }}</dt><dd>{{ overview.firstRecall }}</dd></div>
      </dl>
      <p v-if="overview.nextDueAt !== undefined">
        {{ t('Next review') }} <time :datetime="new Date(overview.nextDueAt).toISOString()">{{ formatReviewTime(overview.nextDueAt) }}</time>
      </p>
      <p v-else class="library-muted">{{ t('No upcoming reviews scheduled.') }}</p>
    </NCard>
    <p v-else class="library-muted" aria-live="polite">{{ t('Loading your progress…') }}</p>
  </section>
</template>

<style scoped>
.progress-page { display: grid; gap: 16px; }
.progress-card { max-width: 760px; }
.progress-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap: 16px; margin-bottom: 16px; }
.progress-stats dd { margin: 4px 0 0; font-size: 1.5rem; font-weight: 650; }
</style>
