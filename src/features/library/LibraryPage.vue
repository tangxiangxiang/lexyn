<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty } from 'naive-ui'
import { RouterLink } from 'vue-router'
import type { Deck } from '../../../shared/domain/library'
import AppIcon from '../../components/AppIcon.vue'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryEditor from './LibraryEditor.vue'
import { closeLibraryMenu, downloadLibrary, useLibraryAction, wordCount } from './library-ui'
import { library } from './api'
import { useLibraryQuery } from './useLibraryQuery'

const { data, error: loadError, reload } = useLibraryQuery(() => null, (_key, signal) => library.listDecks(signal))
const archived = ref(false)
const editor = ref<{ type: 'deck'; deck?: Deck }>()
const toArchive = ref<Deck>()
const feedback = ref('')
const { busy, error, run } = useLibraryAction()
const shown = computed(() => data.value?.filter(({ deck }) => (deck.archivedAt !== undefined) === archived.value) ?? [])

function saved(message: string) {
  feedback.value = message
  editor.value = undefined
}

function archivedDeck() {
  feedback.value = 'Deck archived. You can restore it from Archived decks.'
  toArchive.value = undefined
}

function restore(id: string) {
  void run(async () => {
    await library.setDeckArchived(id, false, data.value!.find(({ deck }) => deck.id === id)!.deck.revision)
    feedback.value = 'Deck restored to Active decks.'
  })
}

function exportAll() {
  void run(async () => {
    await downloadLibrary()
    feedback.value = 'Library JSON export prepared.'
  })
}
</script>

<template>
  <section class="page library-page">
    <header class="page-intro library-heading">
      <div>
        <h1>{{ t('Library') }}</h1>
        <p>{{ t('Pick a book and return to the words you are learning.') }}</p>
      </div>
      <div class="library-actions">
        <NButton secondary :disabled="!data" @click="editor = { type: 'deck' }">{{ t('New deck') }}</NButton>
        <details name="library-options" class="library-menu">
          <summary>{{ t('Library options') }}</summary>
          <div @click="closeLibraryMenu">
            <NButton text :disabled="!data || busy" @click="exportAll">{{ t('Export library') }}</NButton>
            <NButton text :aria-pressed="archived" @click="archived = !archived">{{ t(archived ? 'Active decks' : 'Archived decks') }}</NButton>
          </div>
        </details>
      </div>
    </header>
    <h2 v-if="archived" class="book-shelf-label">{{ t('Archived decks') }}</h2>
    <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
    <NAlert v-if="feedback" type="success" aria-live="polite">{{ t(feedback) }}</NAlert>
    <NAlert v-if="loadError" type="error" role="alert">
      {{ t('Lexyn could not read your library.') }}
      <NButton text @click="reload">{{ t('Retry') }}</NButton>
    </NAlert>
    <p v-else-if="!data" class="library-muted" aria-live="polite">{{ t('Loading your library…') }}</p>
    <NCard v-else-if="!shown.length">
      <div v-if="!archived" class="empty-content">
        <span class="empty-icon"><AppIcon name="library" /></span>
        <h2>{{ t('Your library is empty') }}</h2>
        <p>{{ t('Create a deck to start collecting words.') }}</p>
      </div>
      <NEmpty v-else :description="t('No archived decks')" />
    </NCard>
    <ul v-else class="library-list book-shelf" :aria-label="t('Vocabulary decks')">
      <li v-for="{ deck, count, listCount, completedLists, learnedCount, activeListId, nextListId } in shown" :key="deck.id">
        <article class="book">
          <div class="library-row-copy">
            <h2><RouterLink :to="{ name: 'library-deck', params: { deckId: deck.id } }">{{ deck.name }}</RouterLink></h2>
            <p class="library-muted">{{ wordCount(count) }} · {{ t('{count} lists', { count: listCount }) }}</p>
          </div>
          <p v-if="listCount" class="library-muted book-progress-copy">
            {{ t('{completed} of {total} lists complete', { completed: completedLists, total: listCount }) }}
          </p>
          <div class="library-actions">
            <NButton v-if="archived" secondary :disabled="busy" @click="restore(deck.id)">{{ t('Restore deck') }}</NButton>
            <template v-else>
              <RouterLink v-if="nextListId" class="book-continue" :to="{ name: 'library-deck', params: { deckId: deck.id }, query: { listId: nextListId } }">
                {{ t(learnedCount || activeListId ? 'Continue learning' : 'Open study list') }}
              </RouterLink>
              <details name="library-options" class="library-menu">
                <summary>{{ t('Book options') }}</summary>
                <div @click="closeLibraryMenu">
                  <NButton text @click="editor = { type: 'deck', deck }">{{ t('Edit deck') }}</NButton>
                  <NButton text @click="toArchive = deck">{{ t('Archive deck') }}</NButton>
                </div>
              </details>
            </template>
          </div>
        </article>
      </li>
    </ul>
    <LibraryEditor v-if="editor" :editor="editor" @saved="saved" @close="editor = undefined" />
    <LibraryConfirm v-if="toArchive" :title="t('Archive this deck?')"
      :description="t('“{name}” and its words will remain in your library. You can restore the deck later.', { name: toArchive.name })"
      :label="t('Archive deck')" :action="() => library.setDeckArchived(toArchive!.id, true, toArchive!.revision)"
      @done="archivedDeck" @close="toArchive = undefined" />
  </section>
</template>
