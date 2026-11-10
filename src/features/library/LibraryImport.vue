<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref, shallowRef } from 'vue'
import { NAlert, NButton, NCheckbox, NSelect } from 'naive-ui'
import {
  importFields, parseImport, readImportFile, suggestMapping,
  type FieldMapping, type ImportSource, type TextMode,
} from './import'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'
import { library } from './api'
import { useLibraryQuery } from './useLibraryQuery'

const props = defineProps<{ deckId: string }>()
const emit = defineEmits<{ close: []; imported: [message: string] }>()
const file = shallowRef<Awaited<ReturnType<typeof readImportFile>>>()
const source = shallowRef<ImportSource>()
const mapping = ref<FieldMapping>({})
const textMode = ref<TextMode>('auto')
const overwrite = ref(false)
const { busy, error, run } = useLibraryAction()
const modes = computed(() => [
  { value: 'auto', label: t('Detect automatically') },
  { value: 'words', label: t('One term per line') },
  { value: 'tab', label: t('Term and meaning separated by a tab') },
])
const columns = computed(() => [
  { value: -1, label: t('Choose a column') },
  ...(source.value?.headers.map((header, index) => ({ value: index, label: `${index + 1}. ${header || t('(blank header)')}` })) ?? []),
])
const fieldLabels = { term: 'Term', meaning: 'Meaning', phonetic: 'Phonetic' }
const previewArgs = computed(() => file.value && source.value
  ? [props.deckId, file.value.text, file.value.format, textMode.value, { ...mapping.value }] as const : undefined)
const loaded = useLibraryQuery(previewArgs, (args, signal) =>
  args ? library.previewImport([...args], signal) : Promise.resolve(undefined))
const preview = computed(() => ({ result: loaded.data.value, issue: loaded.error.value }))
const rowsToWrite = computed(() => preview.value.result?.candidates
  .filter((candidate) => overwrite.value || !candidate.match).length ?? 0)
const extraErrors = computed(() => preview.value.result?.rows.slice(10).filter((row) => row.issue).slice(0, 5))

function parse() {
  source.value = undefined
  if (!file.value) return
  source.value = parseImport(file.value.text, file.value.format, textMode.value)
  mapping.value = suggestMapping(source.value.headers)
}

function selectFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0]
  void run(async () => {
    file.value = undefined
    source.value = undefined
    overwrite.value = false
    textMode.value = 'auto'
    if (!selected) return
    file.value = await readImportFile(selected)
    parse()
  })
}

function changeTextMode(mode: TextMode) {
  textMode.value = mode
  void run(async () => parse())
}

async function confirm() {
  const current = preview.value.result
  if (!current || !rowsToWrite.value) return
  const result = await run(() => library.importEntries(props.deckId, current.candidates, overwrite.value ? 'overwrite' : 'skip'))
  if (result) emit('imported', t('Imported {added} new, updated {updated}, skipped {duplicates} duplicates and {invalid} invalid rows.', {
    added: result.added, updated: result.updated, duplicates: current.valid - result.added - result.updated, invalid: current.invalid,
  }))
}
</script>

<template>
  <LibraryDialog :title="t('Import words')" :busy="busy" @close="emit('close')">
    <div class="library-form">
      <p class="library-dialog-copy">{{ t('Choose a UTF-8 TXT or CSV file up to 5 MiB and 10,000 records.') }}</p>
      <label for="library-import-file">{{ t('Vocabulary file') }}</label>
      <input id="library-import-file" type="file" accept=".txt,.csv,text/plain,text/csv"
        :disabled="busy" @change="selectFile">
      <template v-if="file?.format === 'txt'">
        <span id="library-text-mode">{{ t('Text format') }}</span>
        <NSelect :value="textMode" :options="modes" :disabled="busy"
          aria-labelledby="library-text-mode" @update:value="changeTextMode" />
        <p v-if="source" class="library-dialog-copy">
          {{ source.textMode === 'tab' ? t('Reading terms with tab-separated meanings.') : t('Reading one term per line.') }}
        </p>
      </template>
      <fieldset v-if="source?.format === 'csv'" class="library-mapping">
        <legend>{{ t('CSV column mapping') }}</legend>
        <div v-for="field in importFields" :key="field">
          <span :id="`library-map-${field}`">{{ t(fieldLabels[field]) }}</span>
          <NSelect :value="mapping[field] ?? -1" :options="columns" :disabled="busy"
            :aria-labelledby="`library-map-${field}`"
            @update:value="(value: number) => { mapping[field] = value < 0 ? undefined : value }" />
        </div>
      </fieldset>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <NAlert v-if="preview.issue" type="warning">{{ translateError(preview.issue) }}</NAlert>
      <template v-if="preview.result">
        <section :aria-label="t('Import preview')">
          <h3>{{ t('Preview') }}</h3>
          <p class="library-dialog-copy">
            {{ t('{total} total · {valid} valid · {duplicates} duplicates · {invalid} invalid · {missing} missing meanings', {
              total: preview.result.rows.length, valid: preview.result.valid, duplicates: preview.result.duplicates,
              invalid: preview.result.invalid, missing: preview.result.missingMeaning,
            }) }}
          </p>
          <ul v-if="preview.result.rows.length" class="library-preview">
            <li v-for="row in preview.result.rows.slice(0, 10)" :key="row.number">
              <span v-if="row.issue">{{ t('Record {number} · {issue}', { number: row.number, issue: translateError(row.issue ?? '') }) }}</span>
              <template v-else>
                <strong>{{ row.input?.term }}</strong>
                <span>{{ row.input?.meaning || t('Needs meaning') }}</span>
                <small v-if="row.duplicate">{{ row.duplicate === 'file' ? t('Repeated in file') : t('Already in deck') }}</small>
              </template>
            </li>
          </ul>
          <p v-else class="library-dialog-copy">{{ t('There are no data records to import.') }}</p>
          <p v-if="preview.result.rows.length > 10" class="library-dialog-copy">{{ t('Showing the first 10 records.') }}</p>
          <ul v-if="extraErrors?.length" class="library-preview">
            <li v-for="row in extraErrors" :key="row.number">{{ t('Record {number} · {issue}', { number: row.number, issue: translateError(row.issue ?? '') }) }}</li>
          </ul>
        </section>
        <NCheckbox v-if="preview.result.candidates.some((candidate) => candidate.match)"
          v-model:checked="overwrite" :disabled="busy">{{ t('Overwrite matching words in this deck') }}</NCheckbox>
        <p v-if="preview.result.invalid || preview.result.duplicates" class="library-dialog-copy">
          {{ t('Invalid records and later repeats in the file are skipped. Existing words are skipped unless overwrite is selected.') }}
        </p>
        <p v-if="overwrite" class="library-dialog-copy">
          {{ t('Blank or unmapped meanings do not erase an existing meaning when overwriting.') }}
        </p>
      </template>
      <div class="library-dialog-actions">
        <NButton :disabled="busy" @click="emit('close')">{{ t('Cancel') }}</NButton>
        <NButton type="primary" :loading="busy" :disabled="!rowsToWrite" @click="confirm">
          {{ t(rowsToWrite === 1 ? 'Import {count} word' : 'Import {count} words', { count: rowsToWrite }) }}
        </NButton>
      </div>
    </div>
  </LibraryDialog>
</template>
