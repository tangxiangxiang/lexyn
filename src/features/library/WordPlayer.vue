<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { hasFinalMeaning } from '../../../shared/domain/dictionary'
import { study } from '../../api/client'
import AppIcon from '../../components/AppIcon.vue'
import { t, translateError } from '../../i18n/useI18n'
import DictionaryMeaningView from '../dictionary/DictionaryMeaningView.vue'
import { useSpeech } from '../speech/useSpeech'
import { useLibraryQuery } from './useLibraryQuery'
import { saveListeningBookmark, type Playlist } from './listeningBookmark'

const props = defineProps<{ deckId: string; playlist: Playlist }>()
defineEmits<{ close: [] }>()
const position = ref(props.playlist.position)
const looping = ref(false)
const playing = ref(true)
const queueDialog = ref<HTMLDialogElement>()
const queueOpen = ref(false)
const queueOffset = ref(0)
const size = 60
const offset = computed(() => Math.floor(position.value / size) * size)
function loadPage(from: number, signal: AbortSignal) {
  return study('library/words', [props.deckId, from, size, props.playlist.filter, props.playlist.sort, undefined], { signal })
}
const { data, error: listError, reload } = useLibraryQuery(
  offset,
  async (from, signal) => ({ from, page: await loadPage(from, signal) }),
)
const separateQueueOffset = computed(() => queueOpen.value && queueOffset.value !== offset.value ? queueOffset.value : undefined)
const { data: queuePage, error: queueError, reload: reloadQueue } = useLibraryQuery(
  separateQueueOffset,
  async (from, signal) => from === undefined ? undefined : { from, page: await loadPage(from, signal) },
)
const queueEntries = computed(() => {
  const source = queueOffset.value === offset.value ? data.value : queuePage.value
  return source?.from === queueOffset.value ? source.page?.entries : undefined
})
const queueLoadError = computed(() => queueOffset.value === offset.value ? listError.value : queueError.value)
const entry = computed(() => data.value?.from === offset.value
  ? data.value.page?.entries[position.value - offset.value]?.entry
  : undefined)
const count = computed(() => data.value ? data.value.page?.count ?? 0 : props.playlist.count)
const { state, error, toggle, stop } = useSpeech(
  () => ({ entryId: entry.value!.id }),
  () => entry.value ? `${entry.value.id}/${entry.value.revision}` : '',
  () => false,
  advance,
)

function advance() {
  if (!playing.value) return
  if (position.value + 1 < count.value) position.value++
  else if (looping.value && count.value > 1) position.value = 0
  else if (looping.value && entry.value) void toggle()
  else playing.value = false
}

watch(() => entry.value?.id, async (id) => {
  if (!id || !playing.value) return
  await nextTick()
  if (playing.value && entry.value?.id === id) void toggle()
})
watch([error, listError], ([audio, list]) => {
  if (audio || list) playing.value = false
})
watch(count, (total) => {
  if (total === 0) playing.value = false
  position.value = Math.min(position.value, Math.max(0, total - 1))
  queueOffset.value = Math.min(queueOffset.value, Math.floor(Math.max(0, total - 1) / size) * size)
})
watch([() => entry.value?.id, state], ([entryId, status]) => {
  if (entryId && status === 'playing') {
    saveListeningBookmark(props.deckId, { entryId, filter: props.playlist.filter, sort: props.playlist.sort })
  }
})

function togglePlayback() {
  if (playing.value) {
    playing.value = false
    if (state.value === 'playing') void toggle()
    else stop()
    return
  }
  if (!entry.value) return
  playing.value = true
  void toggle()
}

async function showQueue() {
  queueOffset.value = offset.value
  queueOpen.value = true
  queueDialog.value?.showModal()
  await nextTick()
  queueDialog.value?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
}

function selectFromQueue(index: number) {
  position.value = queueOffset.value + index
  queueDialog.value?.close()
}
</script>

<template>
  <section class="spell-player" :aria-label="t('Word player')">
    <header class="spell-subpage-toolbar">
      <button type="button" class="icon-control" :aria-label="t('Open word list')" @click="$emit('close')"><AppIcon name="close" /></button>
      <span v-if="count">{{ position + 1 }} / {{ count }}</span>
    </header>
    <div class="spell-player-word" aria-live="polite">
      <NAlert v-if="listError" type="error">
        {{ t('Lexyn could not read these words.') }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
      </NAlert>
      <template v-else-if="entry">
        <h1>{{ entry.term }}</h1>
        <DictionaryMeaningView v-if="hasFinalMeaning(entry.dictionaryMeaning)" :meaning="entry.dictionaryMeaning!" compact />
        <p v-else class="library-preserve">{{ entry.meaning || t('Meaning not added yet') }}</p>
      </template>
      <p v-else>{{ t(data ? 'No words match this filter.' : 'Loading words…') }}</p>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
    </div>
    <footer class="spell-player-controls">
      <button type="button" class="icon-control" :disabled="!count" :aria-label="t('Playback queue')" aria-haspopup="dialog" @click="showQueue">
        <AppIcon name="queue" />
      </button>
      <button type="button" class="icon-control" :disabled="position === 0" :aria-label="t('Previous word')" @click="position--"><AppIcon name="chevronLeft" /></button>
      <button type="button" class="icon-control spell-player-toggle" :disabled="!entry && !playing"
        :aria-label="t(playing ? 'Pause pronunciation' : 'Play pronunciation')" @click="togglePlayback">
        <AppIcon :name="playing ? 'pause' : 'play'" />
      </button>
      <button type="button" class="icon-control" :disabled="position + 1 >= count" :aria-label="t('Next word')" @click="position++"><AppIcon name="chevronRight" /></button>
      <button type="button" class="icon-control spell-player-loop" :aria-pressed="looping" :aria-label="t('Repeat playlist')" @click="looping = !looping"><AppIcon name="repeat" /></button>
    </footer>
    <dialog ref="queueDialog" class="spell-queue" aria-labelledby="spell-queue-title" @close="queueOpen = false">
      <header>
        <h2 id="spell-queue-title">{{ t('Playback queue') }} ({{ count }})</h2>
        <button type="button" class="icon-control" :aria-label="t('Close queue')" autofocus @click="queueDialog?.close()"><AppIcon name="close" /></button>
      </header>
      <NAlert v-if="queueLoadError" type="error">
        {{ t('Lexyn could not read these words.') }}
        <NButton text @click="queueOffset === offset ? reload() : reloadQueue()">{{ t('Retry') }}</NButton>
      </NAlert>
      <p v-else-if="!queueEntries && count" aria-live="polite">{{ t('Loading words…') }}</p>
      <ol v-else class="spell-queue-items" :start="queueOffset + 1">
        <li v-for="({ entry: word }, index) in queueEntries" :key="word.id">
          <button type="button" :aria-current="queueOffset + index === position ? 'true' : undefined" @click="selectFromQueue(index)">
            <span aria-hidden="true">{{ queueOffset + index + 1 }}</span>
            {{ word.term }}
            <AppIcon v-if="queueOffset + index === position" name="play" />
          </button>
        </li>
      </ol>
      <footer v-if="count > size">
        <button type="button" class="spell-chip" :disabled="queueOffset === 0" @click="queueOffset -= size">{{ t('Previous') }}</button>
        <span aria-live="polite">{{ t('Page {page} of {total}', { page: queueOffset / size + 1, total: Math.ceil(count / size) }) }}</span>
        <button type="button" class="spell-chip" :disabled="queueOffset + size >= count" @click="queueOffset += size">{{ t('Next') }}</button>
      </footer>
    </dialog>
  </section>
</template>
