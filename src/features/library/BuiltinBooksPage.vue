<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { NAlert } from 'naive-ui'
import { t, translateError, useI18n } from '../../i18n/useI18n'
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
watch(() => selectedBook.value?.id, () => { selectedTags.value = builtinWordbookTags.map(({ id }) => id) }, { immediate: true })
const detailKey = computed(() => ({ id: selectedBook.value?.id, tags: [...selectedTags.value] }))
const { data: detail, error: detailLoadError } = useLibraryQuery(detailKey,
  (key, signal) => key.id ? library.builtinBook([key.id, key.tags], signal) : Promise.resolve(undefined),
  ({ id }) => id)
const detailMatchesSelection = computed(() => !!detail.value?.categories.every((category) =>
  category.selected === selectedTags.value.includes(category.id)))
const selectedCount = computed(() => {
  if (!detail.value) return selectedBook.value?.count ?? 0
  return detailMatchesSelection.value ? detail.value.count : 0
})
const formattedCount = computed(() => String(selectedCount.value))
const wordCountSuffix = computed(() => locale.value === 'zh' ? '词' : ' words')
const languageLabels = computed(() => wordbookLanguages.map((language) => ({
  ...language,
  label: t(language.label),
})))
const catalogBooks = computed(() => data.value?.books ?? [])

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
  if (!book?.available || busy.value || !detail.value || !detailMatchesSelection.value
    || !selectedTags.value.length || !selectedCount.value) return
  const result = await run(() => library.createBuiltinBook(book.id, [...selectedTags.value]))
  if (!result) return
  rememberCurrentBook(result.deck.id)
  await reload()
  await router.push({ name: 'library-words', params: { deckId: result.deck.id } })
}
</script>

<template>
  <main class="page spell-wordbooks builtin-books-page">
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
      <nav class="builtin-language-tabs" :aria-label="t('Wordbook language')">
        <button
          v-for="language in languageLabels"
          :key="language.id"
          type="button"
          :class="{ 'is-selected': language.id === 'en' }"
          :aria-current="language.id === 'en' ? 'page' : undefined"
          :disabled="!language.available"
        >{{ language.label }}</button>
      </nav>

      <NAlert v-if="loadError" type="error" role="alert" class="builtin-books-alert">
        {{ t('Built-in wordbooks could not be loaded.') }}
        <button type="button" @click="reload">{{ t('Retry') }}</button>
      </NAlert>
      <p v-else-if="!data" class="wordbooks-loading" aria-live="polite">{{ t('Loading built-in wordbooks…') }}</p>
      <template v-else>
        <p v-if="!data.installed" class="builtin-books-notice" role="status">
          {{ t('ECDICT is not installed on this server.') }}
        </p>

        <section v-if="!bookId" class="builtin-book-catalog" :aria-label="t('Built-in wordbooks')">
          <button
            v-for="book in catalogBooks"
            :key="book.id"
            type="button"
            class="builtin-book-row"
            :class="{ 'is-unavailable': !book.available }"
            :disabled="!book.available"
            @click="openBook(book.id)"
          >
            <span class="builtin-book-row-copy">
              <strong>{{ bookName(book.id) }}</strong>
              <span v-if="book.available">{{ book.count }}{{ wordCountSuffix }}</span>
              <span v-else>{{ t('Not available from the installed dictionary') }}</span>
            </span>
            <AppIcon v-if="book.available" name="chevronRight" />
          </button>
        </section>

        <section v-else-if="selectedBook" class="builtin-book-detail">
          <header class="builtin-book-detail-heading">
            <h1>{{ bookName(selectedBook.id) }}</h1>
          </header>

          <div class="builtin-detail-tabs" role="tablist" :aria-label="t('Wordbook filters')">
            <button type="button" role="tab" aria-selected="true">{{ t('Word composition') }}</button>
            <button type="button" role="tab" aria-selected="false" disabled>{{ t('CEFR levels') }}</button>
            <button type="button" role="tab" aria-selected="false" disabled>{{ t('Collins levels') }}</button>
          </div>

          <p class="builtin-book-detail-count">
            <strong>{{ formattedCount }}</strong><span>{{ wordCountSuffix }}</span>
          </p>
          <div class="builtin-composition-list" :aria-label="t('Word composition')">
            <button
              v-for="category in detail?.categories ?? []"
              :key="category.id"
              type="button"
              class="builtin-composition-row"
              :class="{ 'is-selected': selectedTags.includes(category.id) }"
              :aria-pressed="selectedTags.includes(category.id)"
              @click="toggleCategory(category.id)"
            >
              <span>{{ t(category.name) }}</span>
              <strong>{{ category.count }}{{ wordCountSuffix }}</strong>
            </button>
          </div>
          <p class="builtin-composition-note">{{ t('Word groups can overlap; selected words are counted once.') }}</p>
          <p v-if="!selectedBook.available" class="builtin-books-notice" role="status">
            {{ t('This wordbook is not available from the installed dictionary.') }}
          </p>
          <NAlert v-if="detailLoadError" type="error" role="alert" class="builtin-books-alert">
            {{ t('Wordbook categories could not be loaded.') }}
          </NAlert>
          <NAlert v-if="error" type="error" role="alert" class="builtin-books-alert">{{ translateError(error) }}</NAlert>
          <button class="builtin-choose-button" type="button"
            :disabled="!selectedBook.available || busy || !detail || !detailMatchesSelection || !selectedTags.length || !selectedCount"
            @click="chooseBook">
            {{ t('Choose') }}
          </button>
        </section>
        <section v-else class="wordbooks-empty">
          <h1>{{ t('Wordbook not found') }}</h1>
          <p>{{ t('Choose a built-in wordbook from the list.') }}</p>
          <RouterLink class="builtin-return-link" :to="{ name: 'library-builtin-books' }">{{ t('Built-in wordbooks') }}</RouterLink>
        </section>
      </template>
    </div>
  </main>
</template>
