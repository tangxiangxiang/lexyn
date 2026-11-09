<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty } from 'naive-ui'
import { RouterLink } from 'vue-router'
import type { Deck } from '../../../shared/domain/library'
import AppIcon from '../../components/AppIcon.vue'
import LibraryConfirm from './LibraryConfirm.vue'
import LibraryEditor from './LibraryEditor.vue'
import { downloadLibrary, formatModified, useLibraryAction, wordCount } from './library-ui'
import { library } from './repository'
import { useLibraryQuery } from './useLibraryQuery'

const { data, error: loadError, reload } = useLibraryQuery(() => null, library.listDecks)
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
    await library.setDeckArchived(id, false)
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
        <h1>Library</h1>
        <p>Your vocabulary collections, saved in this browser.</p>
      </div>
      <div class="library-actions">
        <NButton :disabled="!data || busy" @click="exportAll">Export library</NButton>
        <NButton type="primary" :disabled="!data" @click="editor = { type: 'deck' }">New deck</NButton>
      </div>
    </header>
    <div class="library-toolbar" aria-label="Deck filters">
      <NButton :type="archived ? 'default' : 'primary'" secondary :aria-pressed="!archived"
        @click="archived = false">Active decks</NButton>
      <NButton :type="archived ? 'primary' : 'default'" secondary :aria-pressed="archived"
        @click="archived = true">Archived decks</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="feedback" type="success" aria-live="polite">{{ feedback }}</NAlert>
    <NAlert v-if="loadError" type="error" role="alert">
      Lexyn could not read your library.
      <NButton text @click="reload">Retry</NButton>
    </NAlert>
    <p v-else-if="!data" class="library-muted" aria-live="polite">Loading your library…</p>
    <NCard v-else-if="!shown.length">
      <div v-if="!archived" class="empty-content">
        <span class="empty-icon"><AppIcon name="library" /></span>
        <h2>Your library is empty</h2>
        <p>Create a deck to start collecting words.</p>
      </div>
      <NEmpty v-else description="No archived decks" />
    </NCard>
    <ul v-else class="library-list" aria-label="Vocabulary decks">
      <li v-for="{ deck, count, modifiedAt } in shown" :key="deck.id">
        <NCard size="small" class="library-row-card">
          <div class="library-row">
            <div class="library-row-copy">
              <h2><RouterLink :to="{ name: 'library-deck', params: { deckId: deck.id } }">{{ deck.name }}</RouterLink></h2>
              <p v-if="deck.description" class="library-preserve">{{ deck.description }}</p>
              <p class="library-muted">{{ wordCount(count) }} · Updated {{ formatModified(modifiedAt) }}</p>
            </div>
            <div class="library-actions">
              <NButton v-if="archived" secondary :disabled="busy" @click="restore(deck.id)">Restore deck</NButton>
              <template v-else>
                <NButton secondary @click="editor = { type: 'deck', deck }">Edit deck</NButton>
                <NButton secondary @click="toArchive = deck">Archive deck</NButton>
              </template>
            </div>
          </div>
        </NCard>
      </li>
    </ul>
    <LibraryEditor v-if="editor" :editor="editor" @saved="saved" @close="editor = undefined" />
    <LibraryConfirm v-if="toArchive" title="Archive this deck?"
      :description="`“${toArchive.name}” and its words will remain in your library. You can restore the deck later.`"
      label="Archive deck" :action="() => library.setDeckArchived(toArchive!.id, true)"
      @done="archivedDeck" @close="toArchive = undefined" />
  </section>
</template>
