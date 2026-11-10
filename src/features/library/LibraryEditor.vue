<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, reactive } from 'vue'
import { NAlert, NButton, NInput } from 'naive-ui'
import { entryLimits, normalizeTerm, type Deck, type Entry } from '../../../shared/domain/library'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'
import { library } from './api'

const props = defineProps<{ editor: { type: 'deck'; deck?: Deck } | { type: 'entry'; deckId: string; entry?: Entry } }>()
const emit = defineEmits<{ close: []; saved: [message: string] }>()
const { editor } = props
const deck = editor.type === 'deck' ? editor.deck : undefined
const entry = editor.type === 'entry' ? editor.entry : undefined
const title = editor.type === 'deck' ? (deck ? 'Edit deck' : 'New deck') : (entry ? 'Edit word' : 'Add word')
const deckForm = reactive({ name: deck?.name ?? '', description: deck?.description ?? '' })
const entryForm = reactive({
  term: entry?.term ?? '', meaning: entry?.meaning ?? '', phonetic: entry?.phonetic ?? '',
  example: entry?.example ?? '', note: entry?.note ?? '',
})
const changedTerm = computed(() => !!entry && normalizeTerm(entryForm.term) !== entry.normalizedTerm)
const fields = [
  { key: 'term', label: 'Term', multiline: false, optional: false },
  { key: 'meaning', label: 'Meaning', multiline: true, optional: true },
  { key: 'phonetic', label: 'Phonetic', multiline: false, optional: true },
  { key: 'example', label: 'Example', multiline: true, optional: true },
  { key: 'note', label: 'Note', multiline: true, optional: true },
] as const
const { busy, error, run } = useLibraryAction()

async function save() {
  const result = await run(async () => {
    if (editor.type === 'deck') {
      if (deck) await library.updateDeck(deck.id, deckForm, deck.revision)
      else await library.createDeck(deckForm)
      return deck ? 'Deck updated.' : 'Deck created.'
    }
    if (entry) await library.updateEntry(editor.deckId, entry.id, entryForm, entry.revision)
    else await library.createEntry(editor.deckId, entryForm)
    return entry ? 'Word updated.' : 'Word added.'
  })
  if (result) emit('saved', result)
}
</script>

<template>
  <LibraryDialog :title="t(title)" :busy="busy" @close="emit('close')">
    <form class="library-form" @submit.prevent="save">
      <template v-if="editor.type === 'deck'">
        <label for="library-deck-name">{{ t('Deck name') }}</label>
        <NInput v-model:value="deckForm.name" :maxlength="100" :disabled="busy"
          :input-props="{ id: 'library-deck-name', required: true }" />
        <label for="library-deck-description">{{ t('Description') }} <small>{{ t('optional') }}</small></label>
        <NInput v-model:value="deckForm.description" type="textarea" :rows="3" :maxlength="1000" :disabled="busy"
          :input-props="{ id: 'library-deck-description' }" />
      </template>
      <template v-else>
        <template v-for="field in fields" :key="field.key">
          <label :for="`library-word-${field.key}`">{{ t(field.label) }} <small v-if="field.optional">{{ t('optional') }}</small></label>
          <NInput v-model:value="entryForm[field.key]" :type="field.multiline ? 'textarea' : 'text'" :rows="2"
            :maxlength="entryLimits[field.key]" :disabled="busy"
            :input-props="{ id: `library-word-${field.key}`, required: !field.optional }" />
        </template>
      </template>
      <NAlert v-if="changedTerm" type="warning">
        {{ t('Changing the spelling keeps this word’s existing review history and schedule. Add a separate word if it has a different meaning.') }}
      </NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <div class="library-dialog-actions">
        <NButton :disabled="busy" @click="emit('close')">{{ t('Cancel') }}</NButton>
        <NButton type="primary" attr-type="submit" :loading="busy">{{ t('Save') }}</NButton>
      </div>
    </form>
  </LibraryDialog>
</template>
