<script setup lang="ts">
import DictionaryMeaningView from '../dictionary/DictionaryMeaningView.vue'
import PhoneticsView from '../dictionary/PhoneticsView.vue'
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NTag } from 'naive-ui'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppIcon from '../../components/AppIcon.vue'
import { hasRecallPrompt, type DeckListSummary, type Entry } from '../../../shared/domain/library'
import { hasFinalMeaning } from '../../../shared/domain/dictionary'
import { session } from '../../api/client'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryDialog from './LibraryDialog.vue'
import LibraryEditor from './LibraryEditor.vue'
import LibraryImport from './LibraryImport.vue'
import VocabularyBatch from './VocabularyBatch.vue'
import { closeLibraryMenu, downloadLibrary, useLibraryAction, wordCount } from './library-ui'
import { library } from './api'
import type { StudyEndpoints } from '../../../shared/contracts/study'
import { useLibraryQuery } from './useLibraryQuery'

const props = defineProps<{ deckId: string }>()
const route = useRoute()
const router = useRouter()
const { busy, error, run } = useLibraryAction()
const filter = ref<'active' | 'missing' | 'dictionary' | 'review' | 'removed'>('active')
const filters = [
  { value: 'active', label: 'All words' },
  { value: 'missing', label: 'Needs meaning' },
  { value: 'dictionary', label: 'Needs full meanings' },
  { value: 'review', label: 'Suggested check' },
  { value: 'removed', label: 'Removed' },
] as const
const searching = ref(false)
const query = ref('')
const editing = ref<{ entry?: Entry }>()
const removing = ref<Entry>()
const importing = ref(false)
const renaming = ref<DeckListSummary>()
const newListName = ref('')
const listPickerOpen = ref(false)
const hiddenMeanings = ref<Set<string>>(new Set())
const feedback = ref('')
const page = ref(1)
const pageSize = 50

const { data: overview, error: loadError, reload } = useLibraryQuery(() => props.deckId, library.getLists)
const lists = computed(() => overview.value?.lists.filter(({ count }) => count > 0) ?? [])
const activeCount = computed(() => lists.value.reduce((sum, list) => sum + list.count, 0))
const archived = computed(() => overview.value?.deck.archivedAt !== undefined)
const storageKey = computed(() => `lexyn.list.${session.value?.ownerId}.${props.deckId}`)
const rememberedList = ref<string>()
watch(storageKey, (key) => {
  try { rememberedList.value = localStorage.getItem(key) ?? undefined }
  catch { rememberedList.value = undefined }
}, { immediate: true, flush: 'sync' })

const selected = computed(() => lists.value.find(({ id }) => id === route.query.listId)
  ?? lists.value.find(({ id }) => id === rememberedList.value)
  ?? lists.value.find(({ id }) => id === overview.value?.nextListId))
watch(selected, (list) => {
  if (!list || list.deckId !== props.deckId) return
  hiddenMeanings.value = new Set()
  rememberedList.value = list.id
  try { localStorage.setItem(storageKey.value, list.id) } catch { /* The URL keeps the current selection. */ }
})
const index = computed(() => lists.value.findIndex(({ id }) => id === selected.value?.id))
const previous = computed(() => lists.value[index.value - 1])
const next = computed(() => lists.value[index.value + 1])
const listArgs = computed<StudyEndpoints['library/list']['args'] | undefined>(() =>
  !searching.value && selected.value ? [props.deckId, selected.value.id] : undefined)
const { data: words, error: listError, reload: reloadWords } = useLibraryQuery(listArgs,
  (args, signal) => args ? library.getList(args, signal) : Promise.resolve([]), (args) => args?.[1])
const searchArgs = computed<StudyEndpoints['library/deck']['args'] | undefined>(() => searching.value
  ? [props.deckId, query.value.slice(0, 240), filter.value, (page.value - 1) * pageSize, pageSize] : undefined)
const { data: results, error: searchError, reload: reloadSearch } = useLibraryQuery(searchArgs,
  (args, signal) => args ? library.getDeck(args, signal) : Promise.resolve(null), (args) => JSON.stringify(args))
const visible = computed(() => searching.value ? results.value?.entries : words.value)
const pages = computed(() => Math.max(1, Math.ceil((results.value?.total ?? 0) / pageSize)))

watch([query, filter], () => { page.value = 1 }, { flush: 'sync' })
watch(results, (value) => { if (value) page.value = Math.min(page.value, pages.value) })
watch(() => props.deckId, () => {
  editing.value = undefined
  removing.value = undefined
  renaming.value = undefined
  importing.value = false
  feedback.value = ''
  error.value = ''
  closeSearch()
}, { flush: 'sync' })

function closeSearch() {
  searching.value = false
  filter.value = 'active'
  query.value = ''
  page.value = 1
}

function selectList(id: string) {
  closeSearch()
  listPickerOpen.value = false
  void router.replace({ query: { ...route.query, listId: id } })
}

function selectNative(event: Event) {
  const id = (event.currentTarget as HTMLSelectElement).value
  if (id) selectList(id)
}

function toggleMeaning(id: string) {
  const next = new Set(hiddenMeanings.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  hiddenMeanings.value = next
}

function meaningHidden(id: string) {
  return hiddenMeanings.value.has(id)
}

function listStatus(list: DeckListSummary) {
  return list.learned === list.count ? 'List complete'
    : list.learned || list.id === overview.value?.activeListId ? 'Learning in progress' : 'Not started'
}

function saved(message: string) {
  feedback.value = message
  editing.value = undefined
  importing.value = false
}

async function saveListName() {
  if (!renaming.value) return
  const list = renaming.value
  if (await run(async () => { await library.renameList(props.deckId, list.id, newListName.value); return true })) {
    renaming.value = undefined
    feedback.value = 'List renamed.'
  }
}

function restoreWord(entry: Entry) {
  void run(async () => {
    await library.setEntryRemoved(props.deckId, entry.id, false, entry.revision)
    feedback.value = 'Word restored.'
  })
}

function restoreDeck() {
  void run(async () => {
    await library.setDeckArchived(props.deckId, false, overview.value!.deck.revision)
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
  <section class="page library-page deck-reader">
    <NAlert v-if="loadError" type="error" role="alert">
      {{ t('Lexyn could not read this deck.') }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
    </NAlert>
    <p v-else-if="overview === undefined" class="library-muted" aria-live="polite">{{ t('Loading deck…') }}</p>
    <template v-else-if="overview === null">
      <header class="page-intro"><h1>{{ t('Deck not found') }}</h1></header>
      <p>{{ t('This deck is unavailable on the server.') }}</p>
    </template>
    <template v-else>
      <div class="deck-reader-topline">
        <RouterLink to="/library" class="library-back">{{ t('← Back to Library') }}</RouterLink>
        <h1 class="deck-name-muted">{{ overview.deck.name }}</h1>
        <div class="reader-actions">
          <NButton v-if="!searching" text :aria-label="t('Search and filters')" @click="searching = true"><AppIcon name="search" /></NButton>
          <NButton v-else text @click="closeSearch">{{ t('Back to study list') }}</NButton>
          <NButton v-if="archived" secondary :disabled="busy" @click="restoreDeck">{{ t('Restore deck') }}</NButton>
          <details name="library-options" class="library-menu">
            <summary>{{ t('Deck options') }}</summary>
            <div @click="closeLibraryMenu">
              <template v-if="!archived">
                <NButton text @click="editing = {}">{{ t('Add word') }}</NButton>
                <NButton text @click="importing = true">{{ t('Import words') }}</NButton>
                <NButton v-if="selected" text @click="renaming = selected; newListName = selected.name">{{ t('Rename list') }}</NButton>
              </template>
              <NButton text :disabled="busy" @click="exportDeck">{{ t('Export deck') }}</NButton>
            </div>
          </details>
        </div>
      </div>
      <p class="deck-reader-count library-muted">{{ wordCount(activeCount) }} · {{ t('{count} lists', { count: overview.listCount }) }}</p>
      <NAlert v-if="archived" type="info">{{ t('This deck is archived. Restore it to add, edit, or restore words.') }}</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <NAlert v-if="feedback" type="success" aria-live="polite">{{ t(feedback) }}</NAlert>

      <template v-if="searching">
        <NInput v-model:value="query" clearable :placeholder="t('Search words or meanings')"
          :input-props="{ 'aria-label': t('Search words or meanings'), type: 'search' }" />
        <div class="library-toolbar" :aria-label="t('Word filters')">
          <NButton v-for="option in filters" :key="option.value" secondary :aria-pressed="filter === option.value"
            :type="filter === option.value ? 'primary' : 'default'" @click="filter = option.value">{{ t(option.label) }}</NButton>
          <VocabularyBatch v-if="!archived" :key="deckId" :deck-id="deckId" :show-entry="filter === 'missing' || filter === 'dictionary'" />
        </div>
      </template>
      <div v-else-if="selected" class="list-reader-toolbar">
        <NButton class="list-step" :disabled="!previous" :aria-label="t('Previous list')" @click="previous && selectList(previous.id)">‹</NButton>
        <h2 class="list-current-heading">
          <NButton class="list-current" @click="listPickerOpen = true">
            {{ selected.name }} <span aria-hidden="true">⌄</span>
          </NButton>
        </h2>
        <!-- Keep a native control in the accessibility tree and for keyboard/selectOption users. -->
        <select id="deck-list" class="list-reader-hidden-select" :value="selected.id" :aria-label="t('Study list')" @change="selectNative">
          <option v-for="list in lists" :key="list.id" :value="list.id">{{ list.name }}</option>
        </select>
        <NButton class="list-step" :disabled="!next" :aria-label="t('Next list')" @click="next && selectList(next.id)">›</NButton>
        <RouterLink v-if="!archived" class="reader-learn-link" :to="{ path: '/learn', query: { deckId, listId: selected.id } }">
          {{ t(selected.id === overview.activeListId || (selected.learned > 0 && selected.learned < selected.count)
            ? 'Continue learning' : selected.learned === selected.count ? 'Practice this list' : 'Start learning') }}
        </RouterLink>
        <LibraryDialog v-if="listPickerOpen" :title="t('Choose a study list')" @close="listPickerOpen = false">
          <div class="list-picker-grid" role="list" :aria-label="t('Study lists')">
            <button v-for="list in lists" :key="list.id" type="button"
              class="list-picker-option" :class="{ selected: list.id === selected.id }"
              :aria-current="list.id === selected.id ? 'true' : undefined" @click="selectList(list.id)">
              <span>{{ list.name }}</span>
              <small>{{ list.learned === list.count ? '✓' : list.learned ? '·' : '' }} {{ t(listStatus(list)) }}</small>
            </button>
          </div>
        </LibraryDialog>
      </div>
      <p v-if="selected" class="list-reader-meta">
        {{ t('{learned} of {total} words learned', { learned: selected.learned, total: selected.count }) }}
        · {{ t(listStatus(selected)) }}
        <span aria-hidden="true"> · {{ t('{completed} of {total} lists complete', { completed: overview.completedLists, total: overview.listCount }) }}</span>
      </p>

      <NAlert v-if="searching ? searchError : listError" type="error" role="alert">
        {{ t('Lexyn could not read these words.') }} <NButton text @click="searching ? reloadSearch() : reloadWords()">{{ t('Retry') }}</NButton>
      </NAlert>
      <p v-else-if="!visible && (searching || selected)" class="library-muted" aria-live="polite">{{ t('Loading words…') }}</p>
      <NEmpty v-else-if="!visible?.length" :description="query.trim() ? t('No words match this search')
        : searching && filter === 'removed' ? t('No removed words')
        : searching && filter === 'review' ? t('No words suggested for checking')
        : searching && filter === 'dictionary' ? t('No words need full meanings')
        : searching && filter === 'missing' ? t('No words need a meaning') : t('This deck has no words yet')" />
      <ol v-else class="vocabulary-list" role="list" :aria-label="t('Words')">
        <li v-for="(entry, row) in visible" :key="entry.id" role="listitem">
          <article class="vocabulary-row">
            <span class="word-number" aria-hidden="true">{{ String((searching ? (page - 1) * pageSize : 0) + row + 1).padStart(2, '0') }}</span>
            <div class="word-side">
              <h3>{{ entry.term }}</h3>
              <PhoneticsView :phonetics="entry.phonetics" :legacy="entry.phonetic" />
            </div>
            <div class="word-meaning">
              <button v-if="hasRecallPrompt(entry)" type="button" class="meaning-toggle" :aria-expanded="!meaningHidden(entry.id)"
                @click="toggleMeaning(entry.id)">{{ meaningHidden(entry.id) ? t('Show meaning') : t('Hide meaning') }}</button>
              <template v-if="!meaningHidden(entry.id)">
                <DictionaryMeaningView v-if="hasFinalMeaning(entry.dictionaryMeaning)" :meaning="entry.dictionaryMeaning!" compact />
                <p v-else-if="hasRecallPrompt(entry)" class="library-preserve">{{ entry.meaning }}</p>
                <NTag v-else-if="searching" size="small" type="warning">{{ t('Needs meaning') }}</NTag>
              </template>
              <p v-if="searching && entry.termChangedAt !== undefined" class="library-muted">
                {{ t('Spelling changed. Existing review history and schedule are retained.') }}
              </p>
            </div>
            <details v-if="!archived" name="library-options" class="library-menu word-menu">
              <summary :aria-label="t('Options for {word}', { word: entry.term })">···</summary>
              <div @click="closeLibraryMenu">
                <NButton v-if="entry.deletedAt !== undefined" text :disabled="busy" @click="restoreWord(entry)">{{ t('Restore word') }}</NButton>
                <template v-else>
                  <NButton text @click="editing = { entry }">{{ t('Edit word') }}</NButton>
                  <NButton text @click="removing = entry">{{ t('Remove word') }}</NButton>
                </template>
              </div>
            </details>
          </article>
        </li>
      </ol>
      <div v-if="searching && pages > 1" class="library-toolbar" :aria-label="t('Word pages')">
        <NButton :disabled="page === 1" @click="page--">{{ t('Previous') }}</NButton>
        <span class="library-muted">{{ t('Page {page} of {total}', { page, total: pages }) }}</span>
        <NButton :disabled="page === pages" @click="page++">{{ t('Next') }}</NButton>
      </div>
      <LibraryDialog v-if="renaming" :title="t('Rename list')" @close="renaming = undefined">
        <form class="library-form" @submit.prevent="saveListName">
          <label for="study-list-name">{{ t('List name') }}</label>
          <NInput v-model:value="newListName" :maxlength="100" :input-props="{ id: 'study-list-name' }" />
          <NAlert v-if="error" type="error">{{ translateError(error) }}</NAlert>
          <NButton attr-type="submit" type="primary" :disabled="busy || !newListName.trim()">{{ t('Save') }}</NButton>
        </form>
      </LibraryDialog>
      <LibraryEditor v-if="editing" :editor="{ type: 'entry', deckId, entry: editing.entry }"
        @close="editing = undefined" @saved="saved" />
      <LibraryConfirm v-if="removing" :title="t('Remove this word?')"
        :description="t('You can restore “{term}” from the Removed view.', { term: removing.term })" :label="t('Remove word')"
        :action="() => library.setEntryRemoved(deckId, removing!.id, true, removing!.revision)"
        @close="removing = undefined" @done="removing = undefined; feedback = 'Word moved to Removed.'" />
      <LibraryImport v-if="importing" :deck-id="deckId" :list-size="overview.deck.listSize"
        @close="importing = false" @imported="saved" />
    </template>
  </section>
</template>
