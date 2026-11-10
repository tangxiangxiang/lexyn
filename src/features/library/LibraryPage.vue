<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty } from 'naive-ui'
import { RouterLink } from 'vue-router'
import type { Deck } from '../../../shared/domain/library'
import AppIcon from '../../components/AppIcon.vue'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryEditor from './LibraryEditor.vue'
import { downloadLibrary, formatModified, useLibraryAction, wordCount } from './library-ui'
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
        <p>{{ t('Manage the vocabulary collections on your Lexyn server.') }}</p>
      </div>
      <div class="library-actions">
        <NButton :disabled="!data || busy" @click="exportAll">{{ t('Export library') }}</NButton>
        <NButton type="primary" :disabled="!data" @click="editor = { type: 'deck' }">{{ t('New deck') }}</NButton>
      </div>
    </header>
    <div class="library-toolbar" :aria-label="t('Deck filters')">
      <NButton :type="archived ? 'default' : 'primary'" secondary :aria-pressed="!archived"
        @click="archived = false">{{ t('Active decks') }}</NButton>
      <NButton :type="archived ? 'primary' : 'default'" secondary :aria-pressed="archived"
        @click="archived = true">{{ t('Archived decks') }}</NButton>
    </div>
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
    <ul v-else class="library-list" :aria-label="t('Vocabulary decks')">
      <li v-for="{ deck, count, modifiedAt } in shown" :key="deck.id">
        <NCard size="small" class="library-row-card">
          <div class="library-row">
            <div class="library-row-copy">
              <h2><RouterLink :to="{ name: 'library-deck', params: { deckId: deck.id } }">{{ deck.name }}</RouterLink></h2>
              <p v-if="deck.description" class="library-preserve">{{ deck.description }}</p>
              <p class="library-muted">{{ wordCount(count) }} · {{ t('Updated {date}', { date: formatModified(modifiedAt) }) }}</p>
            </div>
            <div class="library-actions">
              <NButton v-if="archived" secondary :disabled="busy" @click="restore(deck.id)">{{ t('Restore deck') }}</NButton>
              <template v-else>
                <NButton secondary @click="editor = { type: 'deck', deck }">{{ t('Edit deck') }}</NButton>
                <NButton secondary @click="toArchive = deck">{{ t('Archive deck') }}</NButton>
              </template>
            </div>
          </div>
        </NCard>
      </li>
    </ul>
    <LibraryEditor v-if="editor" :editor="editor" @saved="saved" @close="editor = undefined" />
    <LibraryConfirm v-if="toArchive" :title="t('Archive this deck?')"
      :description="t('“{name}” and its words will remain in your library. You can restore the deck later.', { name: toArchive.name })"
      :label="t('Archive deck')" :action="() => library.setDeckArchived(toArchive!.id, true, toArchive!.revision)"
      @done="archivedDeck" @close="toArchive = undefined" />
  </section>
</template>
