<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { RouterLink } from 'vue-router'
import type { Deck } from '../../../shared/domain/library'
import AppIcon from '../../components/AppIcon.vue'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryEditor from './LibraryEditor.vue'
import LibraryImport from './LibraryImport.vue'
import { closeLibraryMenu, downloadLibrary, useLibraryAction } from './library-ui'
import { library } from './api'
import { useLibraryQuery } from './useLibraryQuery'
import { clearCurrentBook, currentBookId, rememberCurrentBook } from './currentBook'
import StudyHome from '../learn/StudyHome.vue'

defineProps<{ resumeCurrentBook?: boolean }>()
const { data, error: loadError, reload } = useLibraryQuery(() => null, (_key, signal) => library.listDecks(signal))
const archived = ref(false)
const editor = ref<{ type: 'deck'; deck?: Deck }>()
const importingDeckId = ref<string>()
const toArchive = ref<Deck>()
const feedback = ref('')
const { busy, error, run } = useLibraryAction()
const shown = computed(() => {
  const decks = data.value?.filter(({ deck }) => (deck.archivedAt !== undefined) === archived.value) ?? []
  if (archived.value) return decks
  return [...decks].sort((a, b) => Number(b.deck.id === currentDeckId.value) - Number(a.deck.id === currentDeckId.value))
})
const currentDeckId = ref(currentBookId())
const currentDeckRecord = computed(() => data.value?.find(({ deck }) => deck.id === currentDeckId.value && deck.archivedAt === undefined))
const currentDeck = computed(() => currentDeckRecord.value?.deck)
const shelfDecks = computed(() => archived.value
  ? shown.value
  : shown.value.filter(({ deck }) => deck.id !== currentDeckId.value))
const importTarget = computed(() => data.value?.find(({ deck }) => deck.id === importingDeckId.value && deck.archivedAt === undefined))
const importDeck = computed(() => currentDeck.value
  ?? data.value?.find(({ deck }) => deck.archivedAt === undefined)?.deck)

function selectBook(deckId: string) {
  currentDeckId.value = deckId
  rememberCurrentBook(deckId)
}

function saved(message: string) {
  feedback.value = message
  editor.value = undefined
}

function imported(message: string) {
  feedback.value = message
  importingDeckId.value = undefined
}

function archivedDeck() {
  feedback.value = 'Deck archived. You can restore it from Archived decks.'
  if (toArchive.value?.id === currentDeckId.value) {
    clearCurrentBook()
    currentDeckId.value = undefined
  }
  toArchive.value = undefined
}

function restore(id: string) {
  void run(async () => {
    await library.setDeckArchived(id, false, data.value!.find(({ deck }) => deck.id === id)!.deck.revision)
    feedback.value = 'Deck restored to Active decks.'
    archived.value = false
  })
}

function exportAll() {
  void run(async () => {
    await downloadLibrary()
    feedback.value = 'Library JSON export prepared.'
  })
}

function progressPercent(learned: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, learned / total * 100)) : 0
}
</script>

<template>
  <StudyHome v-if="resumeCurrentBook && currentDeck" :deck-id="currentDeck.id" :deck-name="currentDeck.name" />
  <section v-else class="page library-page spell-wordbooks">
    <div class="wordbooks-toolbar">
      <RouterLink class="wordbooks-back" to="/study" :aria-label="t('Back to study')">
        <AppIcon name="chevronLeft" />
      </RouterLink>
      <details class="wordbooks-page-menu" @click="closeLibraryMenu">
        <summary class="wordbooks-more" :aria-label="t('Page actions')"><AppIcon name="more" /></summary>
        <div class="wordbooks-menu-panel">
          <button type="button" :disabled="!data || busy" @click="exportAll">{{ t('Export library') }}</button>
          <button type="button" :aria-pressed="archived" @click="archived = !archived">
            {{ t(archived ? 'Active decks' : 'Archived decks') }}
          </button>
        </div>
      </details>
    </div>

    <div class="wordbooks-content">
      <header class="wordbooks-heading">
        <h1>
          {{ t(archived ? 'Archived decks' : 'My books') }}
          <span class="wordbooks-total">({{ shown.length }})</span>
        </h1>
      </header>

      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <NAlert v-if="feedback" type="success" aria-live="polite">{{ t(feedback) }}</NAlert>
      <NAlert v-if="loadError" type="error" role="alert">
        {{ t('Lexyn could not read your library.') }}
        <NButton text @click="reload">{{ t('Retry') }}</NButton>
      </NAlert>
      <p v-else-if="!data" class="wordbooks-loading" aria-live="polite">{{ t('Loading your library…') }}</p>

      <div v-else-if="!shown.length" class="wordbooks-empty">
        <AppIcon name="library" />
        <h2>{{ t(archived ? 'No archived decks' : 'Your library is empty') }}</h2>
        <p v-if="!archived">{{ t('Create your first wordbook to start learning.') }}</p>
      </div>

      <template v-else>
        <section v-if="!archived && currentDeckRecord" class="wordbook-featured-section">
          <h2 class="wordbook-section-label">{{ t('Current book') }}</h2>
          <article class="wordbook-featured">
            <RouterLink class="wordbook-featured-open"
              :to="{ name: 'library-words', params: { deckId: currentDeckRecord.deck.id } }"
              @click="selectBook(currentDeckRecord.deck.id)">
              <span class="wordbook-featured-top">
                <span class="wordbook-language">EN</span>
                <span class="wordbook-featured-action">
                  <AppIcon name="chevronRight" /><span class="visually-hidden">{{ t('Open word list') }}</span>
                </span>
              </span>
              <h2>{{ currentDeckRecord.deck.name }}</h2>
              <span class="wordbook-featured-meta">
                <strong>{{ currentDeckRecord.learnedCount }} / {{ currentDeckRecord.count }}</strong>
                <span>{{ t('Words') }}</span><span aria-hidden="true">·</span>
                <span>{{ t('{count} lists', { count: currentDeckRecord.listCount }) }}</span>
              </span>
              <span class="wordbook-progress" role="progressbar"
                :aria-label="t('{learned} of {total} words learned', { learned: currentDeckRecord.learnedCount, total: currentDeckRecord.count })"
                aria-valuemin="0" :aria-valuemax="Math.max(currentDeckRecord.count, 1)"
                :aria-valuenow="Math.min(currentDeckRecord.learnedCount, currentDeckRecord.count)">
                <span :style="{ width: `${progressPercent(currentDeckRecord.learnedCount, currentDeckRecord.count)}%` }"></span>
              </span>
            </RouterLink>
            <details class="wordbook-options" @click="closeLibraryMenu">
              <summary class="wordbooks-more" :aria-label="t('Book options')"><AppIcon name="more" /></summary>
              <div class="wordbooks-menu-panel">
                <button type="button" @click="editor = { type: 'deck', deck: currentDeckRecord.deck }">{{ t('Edit deck') }}</button>
                <button type="button" @click="toArchive = currentDeckRecord.deck">{{ t('Archive deck') }}</button>
              </div>
            </details>
          </article>
        </section>

        <section v-if="shelfDecks.length" class="wordbooks-shelf-section">
          <h2 v-if="!archived && currentDeckRecord" class="wordbooks-shelf-heading">{{ t('Other books') }}</h2>
          <ul class="wordbooks-list" :aria-label="t('Vocabulary decks')">
            <li v-for="{ deck, count, listCount, learnedCount } in shelfDecks" :key="deck.id">
              <article class="wordbook-row" :class="{ 'is-current': deck.id === currentDeckId }">
                <RouterLink class="wordbook-open" :to="{ name: 'library-words', params: { deckId: deck.id } }"
                  :aria-label="deck.name" @click="selectBook(deck.id)">
                  <div class="wordbook-title-line">
                    <h2>{{ deck.name }}</h2>
                  </div>
                  <div class="wordbook-meta">
                    <span class="wordbook-count" :aria-label="t('{learned} of {total} words learned', { learned: learnedCount, total: count })">
                      {{ learnedCount }} / {{ count }}
                    </span>
                    <span>{{ t('Words') }}</span>
                    <span aria-hidden="true">·</span>
                    <span>{{ t('{count} lists', { count: listCount }) }}</span>
                  </div>
                  <span class="wordbook-progress" role="progressbar"
                    :aria-label="t('{learned} of {total} words learned', { learned: learnedCount, total: count })"
                    aria-valuemin="0" :aria-valuemax="Math.max(count, 1)" :aria-valuenow="Math.min(learnedCount, count)">
                    <span :style="{ width: `${progressPercent(learnedCount, count)}%` }"></span>
                  </span>
                  <span class="wordbook-open-arrow" aria-hidden="true"><AppIcon name="chevronRight" /></span>
                </RouterLink>

                <details class="wordbook-options" @click="closeLibraryMenu">
                  <summary class="wordbooks-more" :aria-label="t('Book options')"><AppIcon name="more" /></summary>
                  <div class="wordbooks-menu-panel">
                    <template v-if="archived">
                      <button type="button" :disabled="busy" @click="restore(deck.id)">{{ t('Restore deck') }}</button>
                    </template>
                    <template v-else>
                      <button v-if="deck.id !== currentDeckId" type="button" @click="selectBook(deck.id)">
                        {{ t('Set as current book') }}
                      </button>
                      <button type="button" @click="editor = { type: 'deck', deck }">{{ t('Edit deck') }}</button>
                      <button type="button" @click="toArchive = deck">{{ t('Archive deck') }}</button>
                    </template>
                  </div>
                </details>
              </article>
            </li>
          </ul>
        </section>
      </template>

      <section v-if="!archived" class="wordbooks-actions-section" :aria-label="t('Book actions')">
        <RouterLink class="wordbooks-action" :to="{ name: 'library-builtin-books' }">
          <span>{{ t('Built-in wordbooks') }}</span><AppIcon name="chevronRight" />
        </RouterLink>
        <button type="button" class="wordbooks-action" :disabled="!importDeck || busy"
          @click="importingDeckId = importDeck?.id">
          <span>{{ t('Import words') }}</span><AppIcon name="chevronRight" />
        </button>
        <button type="button" class="wordbooks-action" :disabled="!data || busy"
          @click="editor = { type: 'deck' }">
          <span>{{ t('Create a wordbook') }}</span><AppIcon name="chevronRight" />
        </button>
      </section>
    </div>

    <LibraryEditor v-if="editor" :editor="editor" @saved="saved" @close="editor = undefined" />
    <LibraryImport v-if="importTarget" :deck-id="importTarget.deck.id" :list-size="importTarget.deck.listSize"
      @imported="imported" @close="importingDeckId = undefined" />
    <LibraryConfirm v-if="toArchive" :title="t('Archive this deck?')"
      :description="t('“{name}” and its words will remain in your library. You can restore the deck later.', { name: toArchive.name })"
      :label="t('Archive deck')" :action="() => library.setDeckArchived(toArchive!.id, true, toArchive!.revision)"
      @done="archivedDeck" @close="toArchive = undefined" />
  </section>
</template>
