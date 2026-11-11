<script setup lang="ts">
import { t, translateError, useI18n } from '../../i18n/useI18n'
import { computed, ref, shallowRef } from 'vue'
import { NAlert, NButton, NCard } from 'naive-ui'
import type { LibraryExport } from '../../../shared/contracts/library'
import { MAX_LIBRARY_BACKUP_BYTES, prepareLibraryRestore } from '../../../shared/backup/library'
import { downloadLibrary } from '../library/library-ui'

const { languageTag } = useI18n()
const backup = shallowRef<LibraryExport>()
const busy = ref(false)
const error = ref('')
const details = computed(() => {
  const file = backup.value
  if (!file) return []
  return [
    ['Format version', file.formatVersion], ['Exported', new Date(file.exportedAt).toLocaleString(languageTag.value)],
    ['Decks', file.decks.length], ['Archived decks', file.decks.filter((deck) => deck.archivedAt !== undefined).length],
    ['Words', file.entries.length], ['Removed words', file.entries.filter((word) => word.deletedAt !== undefined).length],
    ...(file.formatVersion === 6 ? [['Study lists', file.lists.length] as const] : []),
    ['Practice events', file.practiceEvents.length], ['Review events', file.reviewEvents.length],
  ] as const
})

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'The backup could not be read.' }
  finally { busy.value = false }
}

function preview(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  backup.value = undefined
  void run(async () => {
    if (file.size > MAX_LIBRARY_BACKUP_BYTES) throw new Error('The backup exceeds 64 MiB.')
    const { backup: validated } = await prepareLibraryRestore(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()))
    backup.value = validated
  })
}
</script>

<template>
  <NCard class="settings-card">
    <section class="backup-settings" :aria-label="t('Data & Backup')">
      <h2>{{ t('Data & Backup') }}</h2>
      <p>{{ t('Download your vocabulary and study history, or check a Lexyn JSON backup before restoring it.') }}</p>
      <NButton :disabled="busy" @click="run(() => downloadLibrary())">{{ t('Download JSON backup') }}</NButton>
      <label class="backup-picker">{{ t('Preview a JSON backup') }}
        <input type="file" accept=".json,application/json" :disabled="busy" @change="preview">
      </label>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <template v-if="backup">
        <h3>{{ t('Backup preview') }}</h3>
        <dl>
          <div v-for="[label, value] in details" :key="label"><dt>{{ t(label) }}</dt><dd>{{ value }}</dd></div>
        </dl>
        <p>{{ t('Restore the file on a new Lexyn server after initializing its Owner. The server command checks for existing data and requires explicit confirmation.') }}</p>
        <code>npm run backup:restore-json -- /path/to/backup.json --confirm-empty</code>
      </template>
    </section>
  </NCard>
</template>

<style scoped>
.backup-settings { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; justify-items: start; }
.backup-settings h2, .backup-settings h3, .backup-settings p, .backup-settings dl { margin: 0; }
.backup-picker { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; width: 100%; }
.backup-picker input { width: 100%; min-width: 0; }
.backup-settings dl > div { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.backup-settings dd { margin: 0; }
.backup-settings code { overflow-wrap: anywhere; }
</style>
