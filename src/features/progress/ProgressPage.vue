<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n/useI18n'
import { NAlert, NButton } from 'naive-ui'
import { RouterLink } from 'vue-router'
import { formatReviewTime, useReviewOverview } from '../review/useReviewOverview'
import { library } from '../library/api'
import { useLibraryQuery } from '../library/useLibraryQuery'

const { data: overview, error, reload } = useReviewOverview(() => undefined, true)
const { data: plan, error: planError, reload: reloadPlan } = useLibraryQuery(() => null, async (_key, signal) => {
  const decks = await library.listDecks(signal)
  const groups = await Promise.all(decks.filter(({ deck }) => deck.archivedAt === undefined).map(async ({ deck }) => {
    const result = await library.getLists(deck.id, signal)
    return result?.lists.filter(({ count }) => count > 0).map((list) => ({ deck, list })) ?? []
  }))
  return groups.flat()
})

const listStats = computed(() => new Map((overview.value?.listStats ?? []).map((stat) => [stat.listId, stat])))
const planRows = computed(() => plan.value?.map((row) => ({
  ...row,
  due: listStats.value.get(row.list.id)?.due ?? 0,
  firstRecall: listStats.value.get(row.list.id)?.firstRecall ?? 0,
  nextDueAt: listStats.value.get(row.list.id)?.nextDueAt,
})))

function retry() {
  void Promise.all([reload(), reloadPlan()])
}
</script>

<template>
  <section class="page progress-page">
    <header class="page-intro plan-heading">
      <h1 :aria-label="t('Progress')">{{ t('Learning plan') }}</h1>
      <p>{{ t('A quiet view of what you learned and what is due next.') }}</p>
    </header>
    <NAlert v-if="error || planError" type="error" role="alert">
      {{ t('Your progress could not be loaded from the server.') }}
      <NButton text @click="retry">{{ t('Try again') }}</NButton>
    </NAlert>
    <template v-else-if="overview">
      <dl class="plan-summary" :aria-label="t('Learning summary')">
        <div><dt>{{ t('Learned for the first time today') }}</dt><dd>{{ overview.learnedToday }}</dd></div>
        <div><dt>{{ t('Reviews rated today') }}</dt><dd>{{ overview.ratedToday }}</dd></div>
        <div><dt>{{ t('Due reviews') }}</dt><dd>{{ overview.due }}</dd></div>
        <div><dt>{{ t('Waiting for first recall') }}</dt><dd>{{ overview.firstRecall }}</dd></div>
      </dl>
      <p v-if="overview.nextDueAt !== undefined" class="plan-next">
        {{ t('Next review') }} <time :datetime="new Date(overview.nextDueAt).toISOString()">{{ formatReviewTime(overview.nextDueAt) }}</time>
      </p>
      <p v-else class="plan-next library-muted">{{ t('No upcoming reviews scheduled.') }}</p>

      <section class="plan-section" aria-labelledby="plan-lists-heading">
        <div class="plan-section-heading">
          <h2 id="plan-lists-heading">{{ t('Study lists') }}</h2>
          <span v-if="planRows" class="library-muted">{{ t('{count} lists', { count: planRows.length }) }}</span>
        </div>
        <p v-if="plan === undefined" class="library-muted" aria-live="polite">{{ t('Loading your study plan…') }}</p>
        <p v-else-if="!planRows?.length" class="library-muted">{{ t('No active study lists.') }}</p>
        <div v-else class="plan-table" role="table" :aria-label="t('Study lists')">
          <div class="plan-table-row plan-table-head" role="row">
            <span role="columnheader">{{ t('List') }}</span>
            <span role="columnheader">{{ t('Learned') }}</span>
            <span role="columnheader">{{ t('Due') }}</span>
            <span role="columnheader">{{ t('Next review') }}</span>
          </div>
          <RouterLink v-for="row in planRows" :key="row.list.id"
            class="plan-table-row"
            :to="{ name: 'library-deck', params: { deckId: row.deck.id }, query: { listId: row.list.id } }">
            <span class="plan-list-name" role="cell">
              <strong>{{ row.list.name }}</strong>
              <small>{{ row.deck.name }}</small>
            </span>
            <span role="cell">{{ row.list.learned }} / {{ row.list.count }}</span>
            <span role="cell">
              <template v-if="row.due">{{ row.due }}</template>
              <template v-else-if="row.firstRecall">{{ row.firstRecall }} {{ t('first recall') }}</template>
              <span v-else class="library-muted">—</span>
            </span>
            <span role="cell">
              <span v-if="row.nextDueAt !== undefined" :data-due-at="row.nextDueAt">{{ formatReviewTime(row.nextDueAt) }}</span>
              <span v-else class="library-muted">—</span>
            </span>
          </RouterLink>
        </div>
      </section>
    </template>
    <p v-else class="library-muted" aria-live="polite">{{ t('Loading your progress…') }}</p>
  </section>
</template>

<style scoped>
.progress-page { display: grid; gap: 16px; }
.plan-heading { margin-bottom: 4px; }
.plan-heading p { max-width: 48ch; }
.plan-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  padding-block: 14px;
  border-block: 1px solid var(--line);
}
.plan-summary dt { color: var(--muted); font-size: .82rem; line-height: 1.35; }
.plan-summary dd { margin: 5px 0 0; font-size: 1.35rem; font-weight: 650; }
.plan-next { color: var(--muted); font-size: .9rem; }
.plan-section { display: grid; gap: 10px; }
.plan-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.plan-section-heading h2 { font-size: 1.05rem; font-weight: 650; }
.plan-table { min-width: 0; border-top: 1px solid var(--line); }
.plan-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(74px, .65fr) minmax(56px, .5fr) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 11px 4px;
  border-bottom: 1px solid var(--line);
  color: inherit;
  text-decoration: none;
}
.plan-table-row:not(.plan-table-head):hover { background: var(--hover-surface); }
.plan-table-head { color: var(--muted); font-size: .78rem; }
.plan-table-row > * { min-width: 0; overflow-wrap: anywhere; }
.plan-list-name { display: grid; gap: 2px; }
.plan-list-name strong { font-weight: 620; }
.plan-list-name small { color: var(--muted); font-size: .78rem; }
.plan-table-row > :not(:first-child) { font-size: .88rem; }

@media (max-width: 640px) {
  .plan-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; }
  .plan-table-row { grid-template-columns: minmax(0, 1.3fr) minmax(52px, .7fr) minmax(46px, .5fr); gap: 8px; }
  .plan-table-row > :last-child { display: none; }
  .plan-table-head > :last-child { display: none; }
}
</style>
