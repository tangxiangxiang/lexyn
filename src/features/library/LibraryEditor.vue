<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NInput } from 'naive-ui'
import { t, translateError } from '../../i18n/useI18n'
import { meaningFromSenses, type DictionaryMeaning, type PhoneticVariants } from '../../../shared/domain/dictionary'
import { normalizeTerm, type Deck, type Entry } from '../../../shared/domain/library'
import { refreshStudy } from '../../api/client'
import DictionaryMeaningEditor from '../dictionary/DictionaryMeaningEditor.vue'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'
import { library } from './api'
import { vocabulary } from './vocabulary-api'

const props = defineProps<{ editor: { type: 'deck'; deck?: Deck } | { type: 'entry'; deckId: string; entry?: Entry } }>()
const emit = defineEmits<{ close: []; saved: [message: string] }>()
const editor = props.editor
const deck = editor.type === 'deck' ? editor.deck : undefined
const entry = editor.type === 'entry' ? editor.entry : undefined
const title = editor.type === 'deck' ? (deck ? 'Edit deck' : 'New deck') : (entry ? 'Edit word' : 'Add word')
const deckForm = reactive({ name: deck?.name ?? '', description: deck?.description ?? '' })
const legacyMeaning: DictionaryMeaning | undefined = entry?.meaning.trim()
  ? { senses: [{ partOfSpeech: '', definitions: [entry.meaning], source: 'manual' }] }
  : undefined
const initialMeaning = entry?.dictionaryMeaning?.senses.some(({ source }) => source !== 'ecdict')
  ? entry.dictionaryMeaning : legacyMeaning
const fullMeaning = ref<DictionaryMeaning | undefined>(initialMeaning)
const phonetics = reactive({
  british: entry?.phonetics?.british ?? '',
  american: entry?.phonetics?.american ?? '',
  unspecified: entry?.phonetics?.unspecified ?? entry?.phonetic ?? '',
})
const entryForm = reactive({ term: entry?.term ?? '' })
const hint = ref('')
const entryRevision = ref(entry?.revision ?? 0)
const meaningText = computed(() => meaningFromSenses(fullMeaning.value?.senses ?? []))
const { busy, error, run } = useLibraryAction()
const ai = useLibraryAction()
const aiBusy = ai.busy
const aiError = ai.error
const snapshot = () => JSON.stringify({ term: entryForm.term, phonetics, senses: fullMeaning.value?.senses ?? [] })
let savedSnapshot = snapshot()
const dirty = computed(() => snapshot() !== savedSnapshot)

watch(() => entryForm.term, (term) => {
  if (!entry || normalizeTerm(term) === entry.normalizedTerm) return
  fullMeaning.value = undefined
  phonetics.british = ''
  phonetics.american = ''
  phonetics.unspecified = ''
}, { flush: 'sync' })

function normalizedPhonetics(): PhoneticVariants | undefined {
  const result = Object.fromEntries(Object.entries(phonetics).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value))
  return Object.keys(result).length ? result as PhoneticVariants : undefined
}

function payload() {
  const senses = (fullMeaning.value?.senses ?? []).map((sense) => ({ ...sense,
    partOfSpeech: sense.partOfSpeech.trim(), domain: sense.domain?.trim() || undefined,
    definitions: [...new Set(sense.definitions.map((text) => text.trim()).filter(Boolean))],
  })).filter((sense) => sense.definitions.length)
  const dictionaryMeaning = senses.length ? { ...fullMeaning.value, senses } as DictionaryMeaning : undefined
  return {
    term: entryForm.term,
    meaning: dictionaryMeaning ? meaningFromSenses(dictionaryMeaning.senses) : '',
    dictionaryMeaning: dictionaryMeaning ?? null,
    phonetics: normalizedPhonetics() ?? null,
    // Retain the historical generic phonetic field for existing speech clients and backups.
    phonetic: phonetics.unspecified.trim(),
    meaningSource: senses.some(({ source }) => source === 'manual') ? 'manual' as const : 'ai' as const,
  }
}

function applyEntry(value: Entry) {
  entryRevision.value = value.revision
  entryForm.term = value.term
  fullMeaning.value = value.dictionaryMeaning?.senses.some(({ source }) => source !== 'ecdict')
    ? value.dictionaryMeaning
    : value.meaning.trim() ? { senses: [{ partOfSpeech: '', definitions: [value.meaning], source: 'manual' }] } : undefined
  phonetics.british = value.phonetics?.british ?? ''
  phonetics.american = value.phonetics?.american ?? ''
  phonetics.unspecified = value.phonetics?.unspecified ?? value.phonetic ?? ''
  savedSnapshot = snapshot()
}

async function optimize() {
  if (editor.type !== 'entry' || !entry || aiBusy.value) return
  await ai.run(async () => {
    let revision = entryRevision.value
    if (dirty.value) {
      const saved = await library.updateEntry(editor.deckId, entry.id, payload(), revision)
      applyEntry(saved)
      revision = saved.revision
    }
    const before = snapshot()
    const updated = await vocabulary.optimize({ entryId: entry.id, revision, hint: hint.value.trim() || undefined })
    if (snapshot() !== before) throw new Error('Your edits changed while AI was working. Save them and retry.')
    applyEntry(updated)
    await refreshStudy()
  })
}

async function save() {
  if (aiBusy.value) return
  const saved = await run(async () => {
    if (editor.type === 'deck') {
      if (deck) await library.updateDeck(deck.id, deckForm, deck.revision)
      else await library.createDeck(deckForm)
      return { message: deck ? 'Deck updated.' : 'Deck created.' }
    }
    if (entry) {
      const updated = await library.updateEntry(editor.deckId, entry.id, payload(), entryRevision.value)
      applyEntry(updated)
      return { message: 'Word updated.' }
    }
    const created = await library.createEntry(editor.deckId, payload())
    // Save first and let the server start AI work asynchronously. Missing credentials or an AI outage
    // never undo the word the user just added.
    void vocabulary.auto(created.id, created.revision).catch(() => undefined).finally(() => refreshStudy())
    return { message: 'Word added.' }
  })
  if (saved) emit('saved', saved.message)
}
</script>

<template>
  <LibraryDialog :title="t(title)" :busy="busy || aiBusy" @close="emit('close')">
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
        <label for="library-word-term">{{ t('Term') }}</label>
        <NInput v-model:value="entryForm.term" :maxlength="240" :disabled="busy || aiBusy"
          :input-props="{ id: 'library-word-term', required: true }" />

        <fieldset class="phonetic-set" :disabled="busy || aiBusy">
          <legend>{{ t('Phonetic') }} <small>{{ t('optional') }}</small></legend>
          <label for="library-phonetic-british">{{ t('British') }}</label>
          <NInput v-model:value="phonetics.british" :maxlength="240"
            :input-props="{ id: 'library-phonetic-british', 'aria-label': t('British phonetic') }" />
          <label for="library-phonetic-american">{{ t('American') }}</label>
          <NInput v-model:value="phonetics.american" :maxlength="240"
            :input-props="{ id: 'library-phonetic-american', 'aria-label': t('American phonetic') }" />
          <label for="library-phonetic-unspecified">{{ t('Unspecified') }}</label>
          <NInput v-model:value="phonetics.unspecified" :maxlength="240"
            :input-props="{ id: 'library-phonetic-unspecified', 'aria-label': t('Unspecified phonetic') }" />
        </fieldset>

        <label>{{ t('Meaning') }}</label>
        <DictionaryMeaningEditor :meaning="fullMeaning" :disabled="busy || aiBusy" @change="fullMeaning = $event" />
        <p v-if="!meaningText" class="library-muted">{{ t('No meaning saved yet. The word will be kept if generation fails.') }}</p>
        <NInput v-if="entry" v-model:value="hint" :maxlength="240" :disabled="busy || aiBusy"
          :placeholder="t('Context hint (optional)')" :input-props="{ 'aria-label': t('Context hint (optional)') }" />
        <NAlert v-if="aiError" type="error" role="alert">
          {{ translateError(aiError) }}
          <NButton text :disabled="busy || aiBusy" @click="optimize">{{ t('Retry AI optimization') }}</NButton>
        </NAlert>
        <div v-if="entry" class="library-actions">
          <NButton :loading="aiBusy" :disabled="busy || aiBusy" @click="optimize">
            {{ t(dirty ? 'Save and optimize with AI' : 'Optimize with AI') }}
          </NButton>
        </div>
      </template>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <div class="library-actions">
        <NButton :disabled="busy || aiBusy" @click="emit('close')">{{ t('Cancel') }}</NButton>
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || aiBusy">{{ t('Save') }}</NButton>
      </div>
    </form>
  </LibraryDialog>
</template>

<style scoped>
.phonetic-set { display: grid; grid-template-columns: minmax(6rem, .35fr) minmax(0, 1fr); align-items: center; gap: .5rem .75rem; min-width: 0; margin: 0; border: 1px solid var(--border); border-radius: .5rem; }
.phonetic-set legend { padding: 0 .35rem; font-weight: 600; }
.phonetic-set label { color: var(--muted); }
@media (max-width: 520px) {
  .phonetic-set { grid-template-columns: minmax(0, 1fr); }
}
</style>
