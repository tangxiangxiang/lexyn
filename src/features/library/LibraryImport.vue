<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { NAlert, NButton, NCheckbox, NSelect } from 'naive-ui'
import { LibraryError, type Entry } from '../../../shared/domain/library'
import {
  importFields, parseImport, previewImport, readImportFile, suggestMapping,
  type FieldMapping, type ImportSource, type TextMode,
} from './import'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'
import { library } from './repository'

const props = defineProps<{ deckId: string; entries: Entry[] }>()
const emit = defineEmits<{ close: []; imported: [message: string] }>()
const file = shallowRef<Awaited<ReturnType<typeof readImportFile>>>()
const source = shallowRef<ImportSource>()
const mapping = ref<FieldMapping>({})
const textMode = ref<TextMode>('auto')
const overwrite = ref(false)
const { busy, error, run } = useLibraryAction()
const modes = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'words', label: 'One term per line' },
  { value: 'tab', label: 'Term and meaning separated by a tab' },
]
const columns = computed(() => [
  { value: -1, label: 'Choose a column' },
  ...(source.value?.headers.map((header, index) => ({ value: index, label: `${index + 1}. ${header || '(blank header)'}` })) ?? []),
])
const preview = computed(() => {
  if (!source.value) return {}
  try {
    return { result: previewImport(source.value, mapping.value, props.entries) }
  } catch (cause) {
    if (!(cause instanceof LibraryError)) throw cause
    return { issue: cause.message }
  }
})
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
  const result = await run(() => library.importEntries(props.deckId, current, overwrite.value ? 'overwrite' : 'skip'))
  if (result) emit('imported', `Imported ${result.added} new, updated ${result.updated}, skipped ${result.skipped} duplicates and ${result.invalid} invalid rows.`)
}
</script>

<template>
  <LibraryDialog title="Import words" :busy="busy" @close="emit('close')">
    <div class="library-form">
      <p class="library-dialog-copy">Choose a UTF-8 TXT or CSV file up to 5 MiB and 10,000 records.</p>
      <label for="library-import-file">Vocabulary file</label>
      <input id="library-import-file" type="file" accept=".txt,.csv,text/plain,text/csv"
        :disabled="busy" @change="selectFile">
      <template v-if="file?.format === 'txt'">
        <span id="library-text-mode">Text format</span>
        <NSelect :value="textMode" :options="modes" :disabled="busy"
          aria-labelledby="library-text-mode" @update:value="changeTextMode" />
        <p v-if="source" class="library-dialog-copy">
          Reading {{ source.textMode === 'tab' ? 'terms with tab-separated meanings' : 'one term per line' }}.
        </p>
      </template>
      <fieldset v-if="source?.format === 'csv'" class="library-mapping">
        <legend>CSV column mapping</legend>
        <div v-for="field in importFields" :key="field">
          <span :id="`library-map-${field}`">{{ field }}</span>
          <NSelect :value="mapping[field] ?? -1" :options="columns" :disabled="busy"
            :aria-labelledby="`library-map-${field}`"
            @update:value="(value: number) => { mapping[field] = value < 0 ? undefined : value }" />
        </div>
      </fieldset>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NAlert v-if="preview.issue" type="warning">{{ preview.issue }}</NAlert>
      <template v-if="preview.result">
        <section aria-label="Import preview">
          <h3>Preview</h3>
          <p class="library-dialog-copy">
            {{ preview.result.rows.length }} total · {{ preview.result.valid }} valid ·
            {{ preview.result.duplicates }} duplicates · {{ preview.result.invalid }} invalid ·
            {{ preview.result.missingMeaning }} missing meanings
          </p>
          <ul v-if="preview.result.rows.length" class="library-preview">
            <li v-for="row in preview.result.rows.slice(0, 10)" :key="row.number">
              <span v-if="row.issue">Record {{ row.number }} · {{ row.issue }}</span>
              <template v-else>
                <strong>{{ row.input?.term }}</strong>
                <span>{{ row.input?.meaning || 'Needs meaning' }}</span>
                <small v-if="row.duplicate">{{ row.duplicate === 'file' ? 'Repeated in file' : 'Already in deck' }}</small>
              </template>
            </li>
          </ul>
          <p v-else class="library-dialog-copy">There are no data records to import.</p>
          <p v-if="preview.result.rows.length > 10" class="library-dialog-copy">Showing the first 10 records.</p>
          <ul v-if="extraErrors?.length" class="library-preview">
            <li v-for="row in extraErrors" :key="row.number">Record {{ row.number }} · {{ row.issue }}</li>
          </ul>
        </section>
        <NCheckbox v-if="preview.result.candidates.some((candidate) => candidate.match)"
          v-model:checked="overwrite" :disabled="busy">Overwrite matching words in this deck</NCheckbox>
        <p v-if="preview.result.invalid || preview.result.duplicates" class="library-dialog-copy">
          Invalid records and later repeats in the file are skipped. Existing words are skipped unless overwrite is selected.
        </p>
      </template>
      <div class="library-dialog-actions">
        <NButton :disabled="busy" @click="emit('close')">Cancel</NButton>
        <NButton type="primary" :loading="busy" :disabled="!rowsToWrite" @click="confirm">
          Import {{ rowsToWrite }} {{ rowsToWrite === 1 ? 'word' : 'words' }}
        </NButton>
      </div>
    </div>
  </LibraryDialog>
</template>
