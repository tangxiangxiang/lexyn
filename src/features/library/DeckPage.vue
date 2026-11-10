<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NTag } from 'naive-ui'
import { RouterLink } from 'vue-router'
import { hasRecallPrompt, type Entry } from '../../../shared/domain/library'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryEditor from './LibraryEditor.vue'
import LibraryImport from './LibraryImport.vue'
import { downloadLibrary, useLibraryAction, wordCount } from './library-ui'
import { library } from './api'
import type { StudyEndpoints } from '../../../shared/contracts/study'
import { useLibraryQuery } from './useLibraryQuery'

const props = defineProps<{ deckId: string }>()
const { busy, error, run } = useLibraryAction()
const filter = ref<'active' | 'missing' | 'removed'>('active')
const filters = [
  { value: 'active', label: 'All words' },
  { value: 'missing', label: 'Needs meaning' },
  { value: 'removed', label: 'Removed' },
] as const
const query = ref('')
const editing = ref<{ entry?: Entry }>()
const removing = ref<Entry>()
const importing = ref(false)
const feedback = ref('')
const page = ref(1)
const pageSize = 50
const args = computed<StudyEndpoints['library/deck']['args']>(() =>
  [props.deckId, query.value.slice(0, 240), filter.value, (page.value - 1) * pageSize, pageSize])
const { data, error: loadError, reload } = useLibraryQuery(args, library.getDeck, (key) => key[0])
const activeCount = computed(() => data.value?.activeCount ?? 0)
const pages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)))
const visible = computed(() => data.value?.entries ?? [])
const archived = computed(() => data.value?.deck.archivedAt !== undefined)

watch([query, filter], () => { page.value = 1 }, { flush: 'sync' })
watch(data, (value) => { if (value) page.value = Math.min(page.value, pages.value) })
watch(() => props.deckId, () => {
  editing.value = undefined
  removing.value = undefined
  importing.value = false
  feedback.value = ''
  error.value = ''
  filter.value = 'active'
  query.value = ''
  page.value = 1
}, { flush: 'sync' })

function saved(message: string) {
  feedback.value = message
  editing.value = undefined
  importing.value = false
}

function restoreWord(entry: Entry) {
  void run(async () => {
    await library.setEntryRemoved(props.deckId, entry.id, false, entry.revision)
    feedback.value = 'Word restored.'
  })
}

function restoreDeck() {
  void run(async () => {
    await library.setDeckArchived(props.deckId, false, data.value!.deck.revision)
    feedback.value = 'Deck restored.'
  })
}

function exportDeck() {
  void run(async () => {
    await downloadLibrary(props.deckId)
    feedback.value = 'Deck JSON export prepared.'
  })
}
</script>

<template>
  <section class="page library-page">
    <RouterLink to="/library" class="library-back">{{ t('← Back to Library') }}</RouterLink>
    <NAlert v-if="loadError" type="error" role="alert">
      {{ t('Lexyn could not read this deck.') }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
    </NAlert>
    <p v-else-if="data === undefined" class="library-muted" aria-live="polite">{{ t('Loading deck…') }}</p>
    <template v-else-if="data === null">
      <header class="page-intro library-heading"><h1>{{ t('Deck not found') }}</h1></header>
      <NCard>{{ t('This deck is unavailable on the server.') }}</NCard>
    </template>
    <template v-else>
      <header class="page-intro library-heading">
        <div class="library-row-copy">
          <h1>{{ data.deck.name }}</h1>
          <p v-if="data.deck.description" class="library-preserve">{{ data.deck.description }}</p>
          <p>{{ wordCount(activeCount) }}</p>
        </div>
        <div class="library-actions">
          <NButton :disabled="busy" @click="exportDeck">{{ t('Export deck') }}</NButton>
          <RouterLink :to="{ path: '/learn', query: { deckId } }" custom v-slot="{ href, navigate }">
            <NButton tag="a" :href="href" :disabled="archived || activeCount === 0" @click="navigate">{{ t('Start learning') }}</NButton>
          </RouterLink>
          <NButton v-if="archived" type="primary" :disabled="busy" @click="restoreDeck">{{ t('Restore deck') }}</NButton>
          <template v-else>
            <NButton @click="importing = true">{{ t('Import words') }}</NButton>
            <NButton type="primary" @click="editing = {}">{{ t('Add word') }}</NButton>
          </template>
        </div>
      </header>
      <NAlert v-if="archived" type="info">{{ t('This deck is archived. Restore it to add, edit, or restore words.') }}</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <NAlert v-if="feedback" type="success" aria-live="polite">{{ t(feedback) }}</NAlert>
      <NInput v-model:value="query" clearable :placeholder="t('Search words or meanings')"
        :input-props="{ 'aria-label': t('Search words or meanings'), type: 'search' }" />
      <div class="library-toolbar" :aria-label="t('Word filters')">
        <NButton v-for="option in filters" :key="option.value" secondary :aria-pressed="filter === option.value"
          :type="filter === option.value ? 'primary' : 'default'" @click="filter = option.value">{{ t(option.label) }}</NButton>
      </div>
      <NCard v-if="!visible.length">
        <NEmpty :description="query.trim() ? t('No words match this search')
          : filter === 'removed' ? t('No removed words')
          : filter === 'missing' ? t('No words need a meaning') : t('This deck has no words yet')" />
      </NCard>
      <ul v-else class="library-list" :aria-label="t('Words')">
        <li v-for="entry in visible" :key="entry.id">
          <NCard size="small" class="library-row-card">
            <article class="library-row">
              <div class="library-row-copy">
                <h2>{{ entry.term }}</h2>
                <p v-if="entry.termChangedAt !== undefined" class="library-muted">
                  {{ t('Spelling changed. Existing review history and schedule are retained.') }}
                </p>
                <p v-if="entry.phonetic" class="library-muted">{{ entry.phonetic }}</p>
                <p v-if="hasRecallPrompt(entry)" class="library-preserve">{{ entry.meaning }}</p>
                <NTag v-else size="small" type="warning">{{ t('Needs meaning') }}</NTag>
                <p v-if="entry.example" class="library-muted library-preserve">{{ entry.example }}</p>
                <p v-if="entry.note" class="library-muted library-preserve">{{ t('Note: {note}', { note: entry.note }) }}</p>
              </div>
              <div v-if="!archived" class="library-actions">
                <NButton v-if="filter === 'removed'" secondary :disabled="busy" @click="restoreWord(entry)">{{ t('Restore word') }}</NButton>
                <template v-else>
                  <NButton secondary @click="editing = { entry }">{{ t('Edit word') }}</NButton>
                  <NButton secondary @click="removing = entry">{{ t('Remove word') }}</NButton>
                </template>
              </div>
            </article>
          </NCard>
        </li>
      </ul>
      <div v-if="pages > 1" class="library-toolbar" :aria-label="t('Word pages')">
        <NButton :disabled="page === 1" @click="page--">{{ t('Previous') }}</NButton>
        <span class="library-muted">{{ t('Page {page} of {total}', { page, total: pages }) }}</span>
        <NButton :disabled="page === pages" @click="page++">{{ t('Next') }}</NButton>
      </div>
      <LibraryEditor v-if="editing" :editor="{ type: 'entry', deckId, entry: editing.entry }"
        @close="editing = undefined" @saved="saved" />
      <LibraryConfirm v-if="removing" :title="t('Remove this word?')"
        :description="t('You can restore “{term}” from the Removed view.', { term: removing.term })" :label="t('Remove word')"
        :action="() => library.setEntryRemoved(deckId, removing!.id, true, removing!.revision)"
        @close="removing = undefined" @done="removing = undefined; feedback = 'Word moved to Removed.'" />
      <LibraryImport v-if="importing" :deck-id="deckId"
        @close="importing = false" @imported="saved" />
    </template>
  </section>
</template>
