<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import { study } from '../../api/client'
import { t, translateError } from '../../i18n/useI18n'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { useLibraryAction } from '../library/library-ui'
import { learn, learnSessionRoute } from './api'
import { useReviewOverview } from '../review/useReviewOverview'
import { library } from '../library/api'
import type { Entry } from '../../../shared/domain/library'
import { settingsRoute } from '../settings/navigation'
import { learningPreferences } from '../../ui/learningPreferences'

const props = defineProps<{ deckId: string; deckName: string }>()
const route = useRoute()
const router = useRouter()
const search = ref('')
const searchFocused = ref(false)
const searchMatches = ref<Entry[]>([])
const searchLoading = ref(false)
const searchError = ref('')
const searchRetry = ref(0)
const searchText = computed(() => search.value.trim().slice(0, 240))
const selection = ref<'all' | 'learn' | 'review'>('learn')
const selectionTouched = ref(false)
watch(() => props.deckId, () => {
  selectionTouched.value = false
  selection.value = 'learn'
})
const { busy, error: startError, run } = useLibraryAction()
const startMessage = ref('')
const { data, error, reload } = useLibraryQuery(
  () => props.deckId,
  (deckId, signal) => learn.getDailyState([deckId, undefined], signal),
)
const { data: reviewData, error: reviewError, reload: reloadReview } = useReviewOverview(() => props.deckId)
const { data: activity } = useLibraryQuery(() => null, (_, signal) => study('progress/activity', [], { signal }))
const streak = computed(() => activity.value?.streak)
const pending = computed(() => data.value
  ? Math.min(data.value.candidates.length, Math.max(0, data.value.quota - data.value.completedToday))
  : undefined)
const reviewPending = computed(() => reviewData.value ? reviewData.value.due + reviewData.value.firstRecall : undefined)
const totalPending = computed(() => pending.value !== undefined && reviewPending.value !== undefined
  ? pending.value + reviewPending.value
  : undefined)
watch([pending, reviewPending], ([learnCount, reviewCount]) => {
  if (!selectionTouched.value && learnCount === 0 && (reviewCount ?? 0) > 0) selection.value = 'review'
})
const displayCount = computed(() => ({
  all: totalPending.value, learn: pending.value, review: reviewPending.value,
})[selection.value])
const displayLabel = computed(() => t({
  all: 'Words to study', learn: 'Words to learn', review: 'Words to review',
}[selection.value]))
const segments = computed(() => {
  // The reference uses one fixed dial split into two equal task segments.
  // Queue sizes belong in the readout; they must not change the ring geometry.
  return { learn: ringSegment(0, 180), review: ringSegment(180, 360) }
})
const startWithReview = computed(() => selection.value === 'review' || (
  selection.value === 'all' && pending.value === 0 && !!reviewPending.value
  && data.value?.activeSession?.deckId !== props.deckId
))
const book = computed(() => ({ name: 'library-deck', params: { deckId: props.deckId } }))

watch([() => props.deckId, searchText, searchFocused, searchRetry], ([deckId, text, focused], _previous, onCleanup) => {
  searchMatches.value = []
  searchError.value = ''
  searchLoading.value = false
  if (!focused || !text) return

  const controller = new AbortController()
  searchLoading.value = true
  const timeout = window.setTimeout(async () => {
    try {
      const result = await library.getDeck([deckId, text, 'active', 0, 6], controller.signal)
      if (!controller.signal.aborted) searchMatches.value = result?.entries ?? []
    } catch (cause) {
      if (!controller.signal.aborted) searchError.value = cause instanceof Error ? cause.message : 'Could not load server data.'
    } finally {
      if (!controller.signal.aborted) searchLoading.value = false
    }
  }, 160)
  onCleanup(() => {
    window.clearTimeout(timeout)
    controller.abort()
  })
}, { flush: 'sync' })

function ringPoint(radius: number, angle: number) {
  const radians = angle * Math.PI / 180
  const x = 160 + radius * Math.sin(radians)
  const y = 160 - radius * Math.cos(radians)
  return `${x.toFixed(2)} ${y.toFixed(2)}`
}

function ringSegment(from: number, to: number) {
  const start = from + 1
  const end = to - 1
  const outer = 149
  const inner = 100
  const corner = Math.min(7, (end - start) / 4)
  const longArc = end - start - 2 * corner > 180 ? 1 : 0
  return [
    `M ${ringPoint(outer - 15, start)}`,
    `Q ${ringPoint(outer, start)} ${ringPoint(outer, start + corner)}`,
    `A ${outer} ${outer} 0 ${longArc} 1 ${ringPoint(outer, end - corner)}`,
    `Q ${ringPoint(outer, end)} ${ringPoint(outer - 15, end)}`,
    `L ${ringPoint(inner + 10, end)}`,
    `Q ${ringPoint(inner, end)} ${ringPoint(inner, end - corner)}`,
    `A ${inner} ${inner} 0 ${longArc} 0 ${ringPoint(inner, start + corner)}`,
    `Q ${ringPoint(inner, start)} ${ringPoint(inner + 10, start)} Z`,
  ].join(' ')
}

function start() {
  startMessage.value = ''
  if (startWithReview.value) {
    if (!reviewPending.value) {
      startMessage.value = 'No study items are ready right now.'
      return
    }
    void router.push({ path: '/review', query: { deckId: props.deckId } })
    return
  }
  const daily = data.value
  if (!daily) return
  const deckId = props.deckId
  const active = daily.activeSession
  if (active?.deckId === deckId && active.status === 'active') {
    void router.push(learnSessionRoute(active))
  } else if (active?.deckId === deckId && active.status === 'paused') {
    void run(async () => {
      const snapshot = await learn.getSession(active.sessionId)
      if (!snapshot) return
      const resumed = await learn.continueSession(snapshot.session.sessionId, snapshot.session.revision)
      await router.push(learnSessionRoute(resumed))
    })
  } else if (active) {
    void router.push({ path: '/learn', query: { deckId } })
  } else if (!pending.value) {
    startMessage.value = 'No study items are ready right now.'
  } else {
    void run(async () => {
      const session = await learn.startSession(deckId, learningPreferences.value.defaultMode, daily.candidates.map(({ id }) => id), true, undefined)
      await router.push(learnSessionRoute(session))
    })
  }
}

function selectQueue(queue: 'all' | 'learn' | 'review') {
  selectionTouched.value = true
  selection.value = queue
  startMessage.value = ''
}

function findWord() {
  searchFocused.value = false
  void router.push({ ...book.value, query: { search: searchText.value } })
}

function handleSearchFocusout(event: FocusEvent) {
  const target = event.relatedTarget
  const form = event.currentTarget as HTMLElement
  if (!(target instanceof Node) || !form.contains(target)) searchFocused.value = false
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !searchFocused.value) return
  event.preventDefault()
  searchFocused.value = false
  searchMatches.value = []
  searchError.value = ''
}

function retrySearch() {
  searchRetry.value += 1
}
</script>

<template>
  <section class="spell-home">
    <h1 class="visually-hidden">{{ t('Current book') }}</h1>
    <div class="spell-home-tools" role="group" :aria-label="t('Study actions')">
      <RouterLink class="icon-control" :to="settingsRoute(route.fullPath)" :aria-label="t('Settings')">
        <img class="spell-home-logo" src="/favicon.svg" alt="" />
      </RouterLink>
      <RouterLink class="icon-control" to="/activity" :aria-label="t('Study activity')">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10.1 2.3a3.8 3.8 0 0 1 3.8 0l5.3 3a3.8 3.8 0 0 1 1.9 3.3v6.8a3.8 3.8 0 0 1-1.9 3.3l-5.3 3a3.8 3.8 0 0 1-3.8 0l-5.3-3a3.8 3.8 0 0 1-1.9-3.3V8.6a3.8 3.8 0 0 1 1.9-3.3z"
            fill="none" stroke="currentColor" stroke-width="1.5" />
          <text x="12" y="16" text-anchor="middle" fill="currentColor" font-size="11" font-weight="650">{{ streak ?? '–' }}</text>
        </svg>
      </RouterLink>
      <RouterLink class="icon-control" :to="{ ...book, name: 'library-words' }" :aria-label="t('Open word list')" :title="deckName"><AppIcon name="bookList" /></RouterLink>
    </div>

    <div class="spell-home-center">
      <div class="spell-ring">
        <svg viewBox="0 0 320 320" role="group" :aria-label="t('Study actions')">
          <path class="spell-ring-segment" role="button" tabindex="0"
            :aria-label="`${t('Words to review')} ${reviewPending ?? '—'}`" :aria-pressed="selection === 'review'"
            :d="segments.review"
            @click="selectQueue('review')" @keydown.enter.prevent="selectQueue('review')" @keydown.space.prevent="selectQueue('review')" />
          <path class="spell-ring-segment" role="button" tabindex="0"
            :aria-label="`${t('Words to learn')} ${pending ?? '—'}`" :aria-pressed="selection === 'learn'"
            :d="segments.learn"
            @click="selectQueue('learn')" @keydown.enter.prevent="selectQueue('learn')" @keydown.space.prevent="selectQueue('learn')" />
          <path class="spell-ring-pointer" aria-hidden="true"
            d="M156 6 H164 Q167 6 166 9 L160 19 L154 9 Q153 6 156 6 Z M159.5 18 H160.5 V60 H159.5 Z" />
        </svg>
        <button class="spell-ring-label" type="button" :aria-pressed="selection === 'all'"
          @click="selectQueue('all')">
          <span class="spell-ring-readout" aria-live="polite" aria-atomic="true">
            <strong>{{ displayCount ?? '—' }}</strong>
            <span>{{ displayLabel }}</span>
          </span>
        </button>
      </div>
      <div class="spell-home-controls">
        <NAlert v-if="error" type="error">
          {{ t('Your learning data could not be loaded from the server.') }}
          <NButton text @click="reload">{{ t('Retry') }}</NButton>
        </NAlert>
        <NAlert v-if="reviewError" type="error">
          {{ t('Your review data could not be loaded from the server.') }}
          <NButton text @click="reloadReview">{{ t('Retry') }}</NButton>
        </NAlert>
        <NAlert v-if="startError" type="error" role="alert">{{ translateError(startError) }}</NAlert>
        <NAlert v-if="startMessage" type="info" role="status">{{ t(startMessage) }}</NAlert>
        <button class="spell-glass spell-start" type="button" :disabled="busy || (startWithReview ? !reviewData : !data)"
          @click="start">{{ t('Start') }}</button>
      </div>
    </div>

    <form class="spell-search spell-glass" @submit.prevent="findWord" @focusout="handleSearchFocusout" @keydown="handleSearchKeydown">
      <button type="submit" class="icon-control" :aria-label="t('Search and filters')"><AppIcon name="search" /></button>
      <input v-model="search" type="search" :aria-label="t('Search words or meanings')" :placeholder="t('Find a word')"
        @focus="searchFocused = true" @input="searchFocused = true" />
      <RouterLink class="icon-control" :to="{ ...book, query: { addWord: '1' } }" :aria-label="t('Add word')"><AppIcon name="plusCircle" /></RouterLink>
      <div v-if="searchFocused && searchText" class="spell-search-results" role="region" :aria-label="t('Search results')">
        <p v-if="searchLoading" class="spell-search-status" role="status">{{ t('Loading words…') }}</p>
        <div v-else-if="searchError" class="spell-search-status" role="alert">
          <span>{{ t('Lexyn could not read these words.') }}</span>
          <button type="button" @click="retrySearch">{{ t('Retry') }}</button>
        </div>
        <p v-else-if="!searchMatches.length" class="spell-search-status" role="status">{{ t('No words match this search') }}</p>
        <ul v-else>
          <li v-for="entry in searchMatches" :key="entry.id">
            <RouterLink class="spell-search-result" :to="{ ...book, name: 'library-words', query: { word: entry.id } }">
              <strong>{{ entry.term }}</strong>
              <span v-if="entry.meaning.trim()">{{ entry.meaning }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </form>
  </section>
</template>
