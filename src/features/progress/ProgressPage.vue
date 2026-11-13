<script setup lang="ts">
import AppIcon from '../../components/AppIcon.vue'
import { computed } from 'vue'
import { t } from '../../i18n/useI18n'
import { NAlert, NButton } from 'naive-ui'
import { RouterLink } from 'vue-router'
import { formatReviewTime, useReviewOverview } from '../review/useReviewOverview'

const { data: overview, error, reload } = useReviewOverview(() => undefined, true)
const books = computed(() => {
  if (!overview.value) return []
  const stats = new Map(overview.value.deckStats.map((stat) => [stat.deckId, stat]))
  const lists = new Map<string, typeof overview.value.lists>()
  for (const list of overview.value.lists) {
    if (!list.count) continue
    const group = lists.get(list.deckId) ?? []
    group.push(list)
    lists.set(list.deckId, group)
  }
  return overview.value.decks.map((deck) => {
    const group = lists.get(deck.id) ?? []
    const count = group.reduce((sum, list) => sum + list.count, 0)
    const learned = group.reduce((sum, list) => sum + list.learned, 0)
    return { deck, group, count, learned, completed: group.filter((list) => list.learned === list.count).length,
      due: stats.get(deck.id)?.due ?? 0, nextDueAt: stats.get(deck.id)?.nextDueAt }
  })
})
const listStats = computed(() => new Map(overview.value?.listStats.map((stat) => [stat.listId, stat])))
const planRows = computed(() => books.value.flatMap(({ deck, group }) => group.map((list) => ({
  deck, list, due: listStats.value.get(list.id)?.due ?? 0,
  firstRecall: listStats.value.get(list.id)?.firstRecall ?? 0,
  nextDueAt: listStats.value.get(list.id)?.nextDueAt,
}))))
</script>

<template>
  <section class="page progress-page">
    <header class="page-toolbar">
      <RouterLink class="icon-control spell-session-back" to="/study" :aria-label="t('Back to study')"><AppIcon name="chevronLeft" /></RouterLink>
      <h1 :aria-label="t('Progress')">{{ t('Learning plan') }}</h1>
    </header>
    <NAlert v-if="error" type="error" role="alert">
      {{ t('Your progress could not be loaded from the server.') }}
      <NButton text @click="reload">{{ t('Try again') }}</NButton>
    </NAlert>
    <template v-else-if="overview">
      <dl class="plan-summary" :aria-label="t('Learning summary')">
        <div><dt>{{ t('Total learned words') }}</dt><dd>{{ overview.learnedTotal }}</dd></div>
        <div><dt>{{ t('Study streak') }}</dt><dd>{{ overview.streak }}</dd></div>
        <div><dt>{{ t('Learned for the first time today') }}</dt><dd>{{ overview.learnedToday }}</dd></div>
        <div><dt>{{ t('Reviews rated today') }}</dt><dd>{{ overview.ratedToday }}</dd></div>
        <div><dt>{{ t('Unique words reviewed today') }}</dt><dd>{{ overview.reviewedWordsToday }}</dd></div>
        <div><dt>{{ t('Due reviews') }}</dt><dd>{{ overview.due }}</dd></div>
        <div><dt>{{ t('Waiting for first recall') }}</dt><dd>{{ overview.firstRecall }}</dd></div>
      </dl>
      <p v-if="overview.nextDueAt !== undefined" class="plan-next">
        {{ t('Next review') }} <time :datetime="new Date(overview.nextDueAt).toISOString()">{{ formatReviewTime(overview.nextDueAt) }}</time>
      </p>
      <p v-else class="plan-next library-muted">{{ t('No upcoming reviews scheduled.') }}</p>

      <p class="plan-next">
        {{ t('Free spelling attempts') }} {{ overview.spelling.freeAttempts }} ·
        {{ t('Incorrect spelling attempts') }} {{ overview.spelling.failures }}
      </p>
      <section v-if="books.length" class="plan-section">
        <div class="plan-section-heading"><h2>{{ t('Wordbook progress') }}</h2></div>
        <ul class="plan-books">
          <li v-for="book in books" :key="book.deck.id">
            <RouterLink :to="{ name: 'library-deck', params: { deckId: book.deck.id } }">{{ book.deck.name }}</RouterLink>
            <span>{{ t('{learned}/{total} learned · {remaining} to learn · {due} due', {
              learned: book.learned, total: book.count, remaining: book.count - book.learned, due: book.due,
            }) }}</span>
            <span>{{ t('{complete}/{total} lists completed', { complete: book.completed, total: book.group.length }) }}</span>
            <span v-if="book.nextDueAt !== undefined">{{ t('Next review') }} {{ formatReviewTime(book.nextDueAt) }}</span>
          </li>
        </ul>
      </section>

      <section class="plan-section" aria-labelledby="plan-lists-heading">
        <div class="plan-section-heading">
          <h2 id="plan-lists-heading">{{ t('Study lists') }}</h2>
          <span v-if="planRows" class="library-muted">{{ t('{count} lists', { count: planRows.length }) }}</span>
        </div>
        <p v-if="!planRows.length" class="library-muted">{{ t('No active study lists.') }}</p>
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
            <span role="cell" :class="{ 'plan-no-date': row.nextDueAt === undefined }">
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
.plan-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 14px;
  border-radius: var(--panel-radius);
  background: var(--panel);
}
.plan-summary dt { color: var(--muted); font-size: .82rem; line-height: 1.35; }
.plan-summary dd { margin: 5px 0 0; font-size: 1.35rem; font-weight: 650; }
.plan-next { color: var(--muted); font-size: .9rem; }
.plan-books { margin: 0; padding: 0; list-style: none; }
.plan-books li { display: grid; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.plan-books li span { color: var(--muted); font-size: .86rem; }
.plan-section { display: grid; gap: 10px; }
.plan-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.plan-section-heading h2 { font-size: 1.05rem; font-weight: 650; }
.plan-table { min-width: 0; border-radius: var(--panel-radius); background: var(--panel); }
.plan-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(74px, .65fr) minmax(56px, .5fr) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 48px;
  padding: 9px 12px;
  color: inherit;
  text-decoration: none;
}
.plan-table-row + .plan-table-row { border-top: 1px solid var(--line); }
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
  .plan-table-row > :last-child { grid-column: 1 / -1; color: var(--muted); }
  .plan-table-row > .plan-no-date, .plan-table-head > :last-child { display: none; }
}
</style>
