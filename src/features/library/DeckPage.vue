<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NTag } from 'naive-ui'
import { RouterLink } from 'vue-router'
import { hasRecallPrompt, normalizeTerm, type Entry } from '../../../shared/domain/library'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryEditor from './LibraryEditor.vue'
import LibraryImport from './LibraryImport.vue'
import { downloadLibrary, useLibraryAction, wordCount } from './library-ui'
import { library } from './repository'
import { useLibraryQuery } from './useLibraryQuery'

const props = defineProps<{ deckId: string }>()
const { data, error: loadError, reload } = useLibraryQuery(() => props.deckId, library.getDeck)
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
const activeCount = computed(() => data.value?.entries.filter((entry) => entry.deletedAt === undefined).length ?? 0)
const filtered = computed(() => {
  const text = normalizeTerm(query.value)
  return (data.value?.entries ?? []).filter((entry) => {
    if ((entry.deletedAt !== undefined) !== (filter.value === 'removed')) return false
    if (filter.value === 'missing' && hasRecallPrompt(entry)) return false
    return !text || entry.normalizedTerm.includes(text) || normalizeTerm(entry.meaning).includes(text)
  })
})
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const archived = computed(() => data.value?.deck.archivedAt !== undefined)

watch([query, filter], () => { page.value = 1 }, { flush: 'sync' })
watch(pages, (count) => { page.value = Math.min(page.value, count) }, { flush: 'sync' })
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

function restoreWord(id: string) {
  void run(async () => {
    await library.setEntryRemoved(props.deckId, id, false)
    feedback.value = 'Word restored.'
  })
}

function restoreDeck() {
  void run(async () => {
    await library.setDeckArchived(props.deckId, false)
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
    <RouterLink to="/library" class="library-back">← Back to Library</RouterLink>
    <NAlert v-if="loadError" type="error" role="alert">
      Lexyn could not read this deck. <NButton text @click="reload">Retry</NButton>
    </NAlert>
    <p v-else-if="data === undefined" class="library-muted" aria-live="polite">Loading deck…</p>
    <template v-else-if="data === null">
      <header class="page-intro library-heading"><h1>Deck not found</h1></header>
      <NCard>This deck is unavailable in this browser.</NCard>
    </template>
    <template v-else>
      <header class="page-intro library-heading">
        <div class="library-row-copy">
          <h1>{{ data.deck.name }}</h1>
          <p v-if="data.deck.description" class="library-preserve">{{ data.deck.description }}</p>
          <p>{{ wordCount(activeCount) }}</p>
        </div>
        <div class="library-actions">
          <NButton :disabled="busy" @click="exportDeck">Export deck</NButton>
          <RouterLink :to="{ path: '/learn', query: { deckId } }" custom v-slot="{ href, navigate }">
            <NButton tag="a" :href="href" :disabled="archived || activeCount === 0" @click="navigate">Start learning</NButton>
          </RouterLink>
          <NButton v-if="archived" type="primary" :disabled="busy" @click="restoreDeck">Restore deck</NButton>
          <template v-else>
            <NButton @click="importing = true">Import words</NButton>
            <NButton type="primary" @click="editing = {}">Add word</NButton>
          </template>
        </div>
      </header>
      <NAlert v-if="archived" type="info">This deck is archived. Restore it to add, edit, or restore words.</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NAlert v-if="feedback" type="success" aria-live="polite">{{ feedback }}</NAlert>
      <NInput v-model:value="query" clearable placeholder="Search words or meanings"
        :input-props="{ 'aria-label': 'Search words or meanings', type: 'search' }" />
      <div class="library-toolbar" aria-label="Word filters">
        <NButton v-for="option in filters" :key="option.value" secondary :aria-pressed="filter === option.value"
          :type="filter === option.value ? 'primary' : 'default'" @click="filter = option.value">{{ option.label }}</NButton>
      </div>
      <NCard v-if="!visible.length">
        <NEmpty :description="query.trim() ? 'No words match this search'
          : filter === 'removed' ? 'No removed words'
          : filter === 'missing' ? 'No words need a meaning' : 'This deck has no words yet'" />
      </NCard>
      <ul v-else class="library-list" aria-label="Words">
        <li v-for="entry in visible" :key="entry.id">
          <NCard size="small" class="library-row-card">
            <article class="library-row">
              <div class="library-row-copy">
                <h2>{{ entry.term }}</h2>
                <p v-if="entry.phonetic" class="library-muted">{{ entry.phonetic }}</p>
                <p v-if="hasRecallPrompt(entry)" class="library-preserve">{{ entry.meaning }}</p>
                <NTag v-else size="small" type="warning">Needs meaning</NTag>
                <p v-if="entry.example" class="library-muted library-preserve">{{ entry.example }}</p>
                <p v-if="entry.note" class="library-muted library-preserve">Note: {{ entry.note }}</p>
              </div>
              <div v-if="!archived" class="library-actions">
                <NButton v-if="filter === 'removed'" secondary :disabled="busy" @click="restoreWord(entry.id)">Restore word</NButton>
                <template v-else>
                  <NButton secondary @click="editing = { entry }">Edit word</NButton>
                  <NButton secondary @click="removing = entry">Remove word</NButton>
                </template>
              </div>
            </article>
          </NCard>
        </li>
      </ul>
      <div v-if="pages > 1" class="library-toolbar" aria-label="Word pages">
        <NButton :disabled="page === 1" @click="page--">Previous</NButton>
        <span class="library-muted">Page {{ page }} of {{ pages }}</span>
        <NButton :disabled="page === pages" @click="page++">Next</NButton>
      </div>
      <LibraryEditor v-if="editing" :editor="{ type: 'entry', deckId, entry: editing.entry }"
        @close="editing = undefined" @saved="saved" />
      <LibraryConfirm v-if="removing" title="Remove this word?"
        :description="`You can restore “${removing.term}” from the Removed view.`" label="Remove word"
        :action="() => library.setEntryRemoved(deckId, removing!.id, true)"
        @close="removing = undefined" @done="removing = undefined; feedback = 'Word moved to Removed.'" />
      <LibraryImport v-if="importing" :deck-id="deckId" :entries="data.entries"
        @close="importing = false" @imported="saved" />
    </template>
  </section>
</template>
