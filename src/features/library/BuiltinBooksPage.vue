<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { NAlert } from 'naive-ui'
import { t, translateError, useI18n } from '../../i18n/useI18n'
import { cefrLevels, defaultWordbookFilters, type WordbookFilters } from '../../../shared/contracts/wordbooks'
import { listSizes } from '../../../shared/domain/library'
import ListSizeField from './ListSizeField.vue'
import AppIcon from '../../components/AppIcon.vue'
import { builtinWordbooks, builtinWordbookTags, wordbookLanguages, type BuiltinWordbookTag } from '../../../shared/domain/builtin-books'
import { library } from './api'
import { rememberCurrentBook } from './currentBook'
import { useLibraryAction } from './library-ui'
import { useLibraryQuery } from './useLibraryQuery'

const route = useRoute()
const router = useRouter()
const { locale } = useI18n()
const { data, error: loadError, reload } = useLibraryQuery(() => 'built-in-wordbooks', (_key, signal) => library.builtinBooks(signal))
const { busy, error, run } = useLibraryAction()
const bookId = computed(() => typeof route.params.bookId === 'string' ? route.params.bookId : undefined)
const selectedBook = computed(() => data.value?.books.find((book) => book.id === bookId.value))
const selectedTags = ref<BuiltinWordbookTag[]>(builtinWordbookTags.map(({ id }) => id))
const filters = ref<WordbookFilters>({ ...defaultWordbookFilters })
const page = ref(0)
const pageSize = 20
const listSize = ref<number | null>(listSizes.default)
const confirming = ref(false)
watch(bookId, () => {
  selectedTags.value = builtinWordbookTags.map(({ id }) => id)
  filters.value = { ...defaultWordbookFilters }
  page.value = 0
  listSize.value = listSizes.default
  confirming.value = false
})
watch([selectedTags, filters], () => { page.value = 0 }, { deep: true })
const detailKey = computed(() => ({
  id: selectedBook.value?.id, tags: [...selectedTags.value],
  filters: { ...filters.value, cefr: [...filters.value.cefr], collins: [...filters.value.collins], states: [...filters.value.states] },
  offset: page.value * pageSize,
}))
const keyOf = (key: typeof detailKey.value) => JSON.stringify(key)
const { data: response, error: detailLoadError, reload: reloadDetail } = useLibraryQuery(detailKey,
  async (key, signal) => key.id ? { key: keyOf(key), detail: await library.builtinBook([key.id, key.tags, key.filters, key.offset, pageSize], signal) } : undefined,
  ({ id }) => id)
const detail = computed(() => response.value?.detail)
const detailMatchesSelection = computed(() => response.value?.key === keyOf(detailKey.value))
const selectedCount = computed(() => detailMatchesSelection.value ? detail.value?.count ?? 0 : undefined)
const validSize = computed(() => Number.isInteger(listSize.value) && listSize.value! >= listSizes.min && listSize.value! <= listSizes.max)
const canInstall = computed(() => selectedBook.value?.available && !busy.value && !detailLoadError.value
  && detailMatchesSelection.value && !!selectedCount.value && validSize.value)
const sortOptions = [
  ['alphabetical', 'Alphabetical (default)'],
  ['bnc-common', 'BNC · most frequent first'], ['bnc-rare', 'BNC · least frequent first'],
  ['frq-common', 'FRQ · most frequent first'], ['frq-rare', 'FRQ · least frequent first'],
] as const
function wordCountSuffix(count: number) {
  return locale.value === 'zh' ? '词' : count === 1 ? ' word' : ' words'
}
const languageLabels = computed(() => wordbookLanguages.map((language) => ({
  ...language,
  label: t(language.label),
})))
const catalogGroups = computed(() => {
  const books = data.value?.books ?? []
  const hasExamTag = (id: string) => !!builtinWordbooks.find((book) => book.id === id)?.tag
  return [
    { label: 'Exam vocabulary', books: books.filter(({ id }) => hasExamTag(id)) },
    { label: 'School vocabulary', books: books.filter(({ id }) => !hasExamTag(id)) },
  ]
})

function bookName(id: string) {
  const definition = builtinWordbooks.find((book) => book.id === id)
  return definition ? t(definition.name) : id
}

function openBook(id: string) {
  void router.push({ name: 'library-builtin-books', params: { bookId: id } })
}

function toggleCategory(tag: BuiltinWordbookTag) {
  selectedTags.value = selectedTags.value.includes(tag)
    ? selectedTags.value.filter((selected) => selected !== tag)
    : [...selectedTags.value, tag]
}

async function chooseBook() {
  const book = selectedBook.value
  if (!book || busy.value) return
  if (book.deckId && !book.deckArchived) {
    rememberCurrentBook(book.deckId)
    await router.push({ name: 'library-words', params: { deckId: book.deckId } })
    return
  }
  if (!book.deckArchived && !canInstall.value) return
  const result = await run(() => library.createBuiltinBook(book.id, [...selectedTags.value], detailKey.value.filters,
    listSize.value ?? listSizes.default, detail.value?.selection || '0'.repeat(64)))
  if (!result) { await reloadDetail(); return }
  rememberCurrentBook(result.deck.id)
  await reload()
  await router.push({ name: 'library-words', params: { deckId: result.deck.id } })
}
</script>

<template>
  <section class="page spell-wordbooks builtin-books-page">
    <div class="wordbooks-toolbar">
      <RouterLink
        class="wordbooks-back"
        :to="bookId ? { name: 'library-builtin-books' } : '/library'"
        :aria-label="t(bookId ? 'Back to built-in wordbooks' : 'Back to my books')"
      >
        <AppIcon name="chevronLeft" />
      </RouterLink>
    </div>

    <div class="builtin-books-content">
      <h1 v-if="!bookId" class="builtin-catalog-title">{{ t('Built-in wordbooks') }}</h1>
      <div role="group" class="builtin-language-tabs" :aria-label="t('Wordbook language')">
        <button
          v-for="language in languageLabels"
          :key="language.id"
          type="button"
          :class="{ 'is-selected': language.id === 'en' }"
          :aria-current="language.id === 'en' ? 'page' : undefined"
          :disabled="!language.available"
        >{{ language.label }}</button>
      </div>

      <NAlert v-if="loadError" type="error" role="alert" class="builtin-books-alert">
        {{ t('Built-in wordbooks could not be loaded.') }}
        <button type="button" @click="reload">{{ t('Retry') }}</button>
      </NAlert>
      <p v-else-if="!data" class="wordbooks-loading" aria-live="polite">{{ t('Loading built-in wordbooks…') }}</p>
      <template v-else>
        <p v-if="!data.installed" class="builtin-books-notice" role="status">
          {{ t('ECDICT is not installed on this server.') }}
        </p>

        <template v-if="!bookId">
          <section v-for="group in catalogGroups" :key="group.label" class="builtin-book-catalog" :aria-label="t(group.label)">
            <h2 class="builtin-section-title">{{ t(group.label) }}</h2>
            <button
              v-for="book in group.books"
              :key="book.id"
              type="button"
              class="builtin-book-row"
              :class="{ 'is-unavailable': !book.available && !book.deckId }"
              :disabled="!book.available && !book.deckId"
              @click="openBook(book.id)"
            >
              <span class="builtin-book-row-copy">
                <strong>{{ bookName(book.id) }}</strong>
                <span v-if="book.available">{{ book.count }}{{ wordCountSuffix(book.count) }}</span>
                <span v-else-if="book.deckId">{{ t('Installed wordbook') }}</span>
                <span v-else>{{ t(group.label === 'School vocabulary' ? 'No verified school word list' : 'Not available from the installed dictionary') }}</span>
              </span>
              <AppIcon v-if="book.available || book.deckId" name="chevronRight" />
            </button>
          </section>
        </template>

        <section v-else-if="selectedBook" class="builtin-book-detail">
          <header class="builtin-book-detail-heading">
            <h1>{{ bookName(selectedBook.id) }}</h1>
          </header>

          <template v-if="!selectedBook.deckId && selectedBook.available">
            <p class="builtin-composition-note">{{ t('Exam tags are supplied by ECDICT. Official exam coverage may differ.') }}</p>
            <p class="builtin-book-detail-count" aria-live="polite">
              <template v-if="selectedCount !== undefined">
                <strong>{{ selectedCount }}</strong><span>{{ wordCountSuffix(selectedCount) }}</span>
              </template>
              <span v-else>{{ t('Loading wordbook preview…') }}</span>
            </p>
            <p v-if="detailMatchesSelection && detail" class="builtin-composition-note">
              {{ t('{total} in the book · {learned} learned · {remaining} to learn', {
                total: selectedBook.count, learned: detail.learned, remaining: detail.count - detail.learned,
              }) }}
            </p>
            <details class="builtin-filters">
              <summary>{{ t('Wordbook filters') }}</summary>
              <div class="builtin-composition-list" :aria-label="t('Word composition')">
                <button v-for="category in detail?.categories ?? []" :key="category.id" type="button"
                  class="builtin-composition-row" :class="{ 'is-selected': selectedTags.includes(category.id) }"
                  :aria-pressed="selectedTags.includes(category.id)" @click="toggleCategory(category.id)">
                  <span>{{ t(category.name) }}</span>
                  <strong>{{ category.count }}{{ wordCountSuffix(category.count) }}</strong>
                </button>
              </div>
              <fieldset>
                <legend>{{ t('CEFR levels') }}</legend>
                <p v-if="detail && !detail.cefrAvailable">{{ t('CEFR sources have not been installed.') }}</p>
                <p v-else-if="detail && detail.cefrLevels.length < cefrLevels.length">{{ t('Some CEFR levels have no installed data.') }}</p>
                <label v-for="level in cefrLevels" :key="level">
                  <input v-model="filters.cefr" type="checkbox" :value="level" :disabled="!detail?.cefrLevels.includes(level)" />{{ level }}
                </label>
                <label><input v-model="filters.cefr" type="checkbox" value="unknown" />{{ t('Unknown level') }}</label>
              </fieldset>
              <fieldset>
                <legend>{{ t('Collins levels') }}</legend>
                <p v-if="detail && !detail.coverage.collins">{{ t('No Collins data in this wordbook.') }}</p>
                <label v-for="star in 5" :key="star">
                  <input v-model="filters.collins" type="checkbox" :value="star" :disabled="!detail?.coverage.collins" />{{ star }} ★
                </label>
              </fieldset>
              <fieldset>
                <legend>{{ t('Learning status') }}</legend>
                <label><input v-model="filters.states" type="checkbox" value="learned" />{{ t('Learned') }}</label>
                <label><input v-model="filters.states" type="checkbox" value="unlearned" />{{ t('Unlearned') }}</label>
                <label><input v-model="filters.states" type="checkbox" value="due" />{{ t('Due reviews') }}</label>
              </fieldset>
              <label class="builtin-sort">{{ t('Word order') }}
                <select v-model="filters.order">
                  <option v-for="[value, label] in sortOptions" :key="value" :value="value"
                    :disabled="value.startsWith('bnc') ? !detail?.coverage.bnc : value.startsWith('frq') && !detail?.coverage.frq">
                    {{ t(label) }}
                  </option>
                </select>
              </label>
            </details>
            <div v-if="detailMatchesSelection && detail" class="builtin-preview">
              <h2 class="builtin-section-title">{{ t('Wordbook preview') }}</h2>
              <p v-if="!detail.count">{{ t('No words match this filter.') }}</p>
              <ul v-else>
                <li v-for="entry in detail.entries" :key="entry.word">
                  <span><strong>{{ entry.word }}</strong> <small v-if="entry.phonetic">{{ entry.phonetic }}</small></span>
                  <span>{{ entry.meaning }}</span>
                  <small v-if="entry.learned || entry.classifications.some((row) => row.cefr)">
                    {{ [...new Set(entry.classifications.flatMap(({ cefr }) => cefr ? [cefr] : []))].join(' / ') }}
                    {{ entry.learned ? t('Learned') : '' }}
                  </small>
                </li>
              </ul>
              <div v-if="detail.count > pageSize" class="builtin-pagination">
                <button type="button" :disabled="page === 0" @click="page--">{{ t('Previous page') }}</button>
                <span>{{ page + 1 }} / {{ Math.ceil(detail.count / pageSize) }}</span>
                <button type="button" :disabled="(page + 1) * pageSize >= detail.count" @click="page++">{{ t('Next page') }}</button>
              </div>
            </div>
            <details v-if="detail?.sources.length" class="builtin-filters">
              <summary>{{ t('Vocabulary sources') }}</summary>
              <ul class="builtin-sources">
                <li v-for="source in detail.sources" :key="source.name">
                  <a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.name }} {{ source.version }}</a>
                  <span>{{ source.license }}</span>
                </li>
              </ul>
            </details>
            <div v-if="confirming" class="builtin-confirm">
              <ListSizeField id="builtin-list-size" v-model="listSize" :disabled="busy" />
              <button type="button" :disabled="busy" @click="confirming = false">{{ t('Cancel') }}</button>
            </div>
          </template>
          <p v-if="!selectedBook.available && !selectedBook.deckId" class="builtin-books-notice" role="status">
            {{ t('This wordbook is not available from the installed dictionary.') }}
          </p>
          <NAlert v-if="detailLoadError" type="error" role="alert" class="builtin-books-alert">
            {{ t('Wordbook categories could not be loaded.') }} <button type="button" @click="reloadDetail">{{ t('Retry') }}</button>
          </NAlert>
          <NAlert v-if="error" type="error" role="alert" class="builtin-books-alert">{{ translateError(error) }}</NAlert>
          <button class="builtin-choose-button" type="button"
            :disabled="busy || (!selectedBook.deckId && !canInstall)"
            @click="selectedBook.deckId || confirming ? chooseBook() : confirming = true">
            {{ t(busy ? 'Installing wordbook…' : selectedBook.deckArchived ? 'Restore deck' : selectedBook.deckId ? 'Open wordbook' : confirming ? 'Install wordbook' : 'Choose') }}
          </button>
        </section>
        <section v-else class="wordbooks-empty">
          <h1>{{ t('Wordbook not found') }}</h1>
          <p>{{ t('Choose a built-in wordbook from the list.') }}</p>
          <RouterLink class="builtin-return-link" :to="{ name: 'library-builtin-books' }">{{ t('Built-in wordbooks') }}</RouterLink>
        </section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.builtin-section-title { margin: 0; font-size: 1rem; font-weight: 650; }
.builtin-filters, .builtin-preview, .builtin-confirm { display: grid; gap: 10px; min-width: 0; }
.builtin-filters summary { min-height: 44px; padding: 10px 0; cursor: pointer; }
.builtin-filters fieldset { display: flex; flex-wrap: wrap; gap: 0 12px; min-width: 0; padding: 4px 0; border: 0; }
.builtin-filters fieldset p { width: 100%; margin: 4px 0; }
.builtin-filters fieldset label { display: inline-flex; align-items: center; gap: 5px; min-height: 40px; }
.builtin-sort { display: grid; gap: 6px; }
.builtin-sort select { max-width: 100%; min-height: 40px; }
.builtin-preview ul, .builtin-sources { margin: 0; padding: 0; list-style: none; }
.builtin-preview li, .builtin-sources li { display: grid; gap: 3px; padding: 9px 0; border-bottom: 1px solid #c5dcff33; overflow-wrap: anywhere; }
.builtin-preview li small { opacity: .8; }
.builtin-pagination { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.builtin-pagination button, .builtin-confirm > button { min-height: 40px; }
.builtin-sources a { color: inherit; }
</style>
