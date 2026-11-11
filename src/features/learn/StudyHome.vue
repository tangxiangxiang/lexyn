<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import { t, translateError } from '../../i18n/useI18n'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { useLibraryAction } from '../library/library-ui'
import { learn } from './api'

const props = defineProps<{ deckId: string; deckName: string }>()
const router = useRouter()
const search = ref('')
const { busy, error: startError, run } = useLibraryAction()
const { data, error, reload } = useLibraryQuery(
  () => props.deckId,
  (deckId, signal) => learn.getDailyState([deckId, undefined], signal),
)
const pending = computed(() => data.value
  ? Math.min(data.value.candidates.length, Math.max(0, data.value.quota - data.value.completedToday))
  : undefined)
const completed = computed(() => data.value
  ? Math.min(100, 100 * data.value.completedToday / Math.max(1, data.value.quota))
  : 0)
const book = computed(() => ({ name: 'library-deck', params: { deckId: props.deckId } }))

function start() {
  const daily = data.value
  if (!daily) return
  const deckId = props.deckId
  const active = daily.activeSession
  if (active?.deckId === deckId && active.status === 'active') {
    const path = active.mode === 'copy' && !active.currentAttempts ? '/learn/read' : '/learn/spell'
    void router.push({ path, query: { deckId, listId: active.listId, session: active.sessionId } })
  } else if (active || !pending.value) {
    void router.push({ path: '/learn', query: { deckId } })
  } else {
    void run(async () => {
      const session = await learn.startSession(deckId, 'copy', daily.candidates.map(({ id }) => id), true, undefined)
      await router.push({ path: '/learn/read', query: { deckId, listId: session.listId, session: session.sessionId } })
    })
  }
}

function findWord() {
  void router.push({ ...book.value, query: { search: search.value.trim() } })
}
</script>

<template>
  <section class="spell-home">
    <h1 class="visually-hidden">{{ t('Current book') }}</h1>
    <div class="spell-home-tools" role="group" :aria-label="t('Study actions')">
      <RouterLink class="icon-control" to="/library" :aria-label="t('Library')"><AppIcon name="library" /></RouterLink>
      <RouterLink class="icon-control" to="/activity" :aria-label="t('Study activity')"><AppIcon name="calendar" /></RouterLink>
      <RouterLink class="icon-control" :to="{ ...book, name: 'library-words' }" :aria-label="t('Open word list')" :title="deckName"><AppIcon name="bookList" /></RouterLink>
    </div>

    <div class="spell-home-center">
      <div class="spell-ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="spell-ring-track" cx="60" cy="60" r="49" pathLength="100" stroke-dasharray="86 14" transform="rotate(-85 60 60)" />
          <circle v-if="completed > 0" class="spell-ring-fill" cx="60" cy="60" r="49" pathLength="100"
            :stroke-dasharray="`${completed * .86} 100`" transform="rotate(-85 60 60)" />
        </svg>
        <div class="spell-ring-label" aria-live="polite">
          <strong>{{ pending ?? '—' }}</strong>
          <span>{{ t('Words to learn') }}</span>
        </div>
      </div>
      <NAlert v-if="error" type="error">
        {{ t('Your learning data could not be loaded from the server.') }}
        <NButton text @click="reload">{{ t('Retry') }}</NButton>
      </NAlert>
      <NAlert v-if="startError" type="error" role="alert">{{ translateError(startError) }}</NAlert>
      <button class="spell-glass spell-start" type="button" :disabled="!data || busy" @click="start">{{ t('Start') }}</button>
    </div>

    <form class="spell-search spell-glass" @submit.prevent="findWord">
      <button type="submit" class="icon-control" :aria-label="t('Search and filters')"><AppIcon name="search" /></button>
      <input v-model="search" type="search" :aria-label="t('Search words or meanings')" :placeholder="t('Find a word')" />
      <RouterLink class="icon-control" :to="{ ...book, query: { addWord: '1' } }" :aria-label="t('Add word')"><AppIcon name="plusCircle" /></RouterLink>
    </form>
  </section>
</template>
