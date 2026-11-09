<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NInput, NSelect } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { isSpellingCorrect } from '../../../shared/domain/learning'
import { reviewRatings, type ReviewRating } from '../../../shared/domain/review'
import ReviewPronunciation from './ReviewPronunciation.vue'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { review, ReviewError } from './repository'
import { formatReviewTime, useReviewOverview } from './useReviewOverview'

const route = useRoute()
const router = useRouter()
const deckId = computed(() => typeof route.query.deckId === 'string' ? route.query.deckId : undefined)
const { data: overview, error: overviewError, reload: reloadOverview } = useReviewOverview(deckId)
const { data: round, error: roundError, reload: reloadRound } = useLibraryQuery(deckId, (id) => review.round(id))
const deckOptions = computed(() => overview.value?.decks.map(({ id, name }) => ({ label: name, value: id })) ?? [])
const answer = ref('')
const busy = ref(false)
const error = ref('')
const composing = ref(false)
const focusTarget = ref<HTMLElement>()
const cardKey = computed(() => {
  const session = round.value?.session
  return session?.status === 'active' && session.currentCardId
    ? session.sessionId + '/' + session.currentCardId : undefined
})
const revealed = computed(() => round.value?.revealed ?? false)
const spellCheck = computed(() => {
  const word = round.value?.word
  if (!revealed.value || !word || !answer.value.trim()) return undefined
  return isSpellingCorrect(word.entry.term, answer.value)
})
const ratingLabels = {
  again: { label: 'Again', hint: 'Could not recall' },
  hard: { label: 'Hard', hint: 'Recalled with effort' },
  good: { label: 'Good', hint: 'Recalled normally' },
  easy: { label: 'Easy', hint: 'Recalled easily' },
} satisfies Record<ReviewRating, { label: string; hint: string }>

watch(() => round.value?.session, (session) => {
  if (session?.status === 'active' && session.deckId !== deckId.value) selectDeck(session.deckId ?? null)
})

watch(cardKey, () => {
  answer.value = ''
  composing.value = false
  error.value = ''
})
watch([cardKey, revealed], async () => {
  await nextTick()
  focusTarget.value?.focus()
}, { flush: 'post' })

async function run(action: () => Promise<unknown>) {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof ReviewError ? cause.message : 'Review could not be saved on this device. Try again.'
  } finally {
    busy.value = false
  }
}

function repair() {
  const session = round.value?.session
  if (session) void run(() => review.repair(session.sessionId, session.currentCardId))
}

let repairAttempted: typeof round.value
watch([round, busy], ([current, saving]) => {
  if (saving || current?.session.status !== 'active' || current.word || current === repairAttempted) return
  repairAttempted = current
  repair()
})

function reveal() {
  const current = round.value
  const cardId = current?.session.currentCardId
  if (!current?.word || !cardId || revealed.value || composing.value) return
  const { session, word } = current
  void run(() => review.reveal(session.sessionId, cardId, word.entry.revision))
}

function rate(rating: ReviewRating) {
  const session = round.value?.session
  const cardId = session?.currentCardId
  if (!session || !cardId || !revealed.value || composing.value) return
  void run(() => review.score(session.sessionId, cardId, rating))
}

function changeStatus(status: 'active' | 'paused' | 'abandoned') {
  const session = round.value?.session
  if (session) void run(() => review.setStatus(session.sessionId, status))
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.isComposing || event.keyCode === 229 || composing.value || busy.value
    || document.querySelector('dialog[open], [aria-modal="true"]')) return
  const target = event.target
  if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable="true"]')) return
  if (event.key === ' ' && !revealed.value && !target.closest('button, a')) {
    event.preventDefault()
    if (!event.repeat) reveal()
  } else if (revealed.value && /^[1-4]$/.test(event.key)) {
    event.preventDefault()
    if (!event.repeat) rate(reviewRatings[Number(event.key) - 1])
  }
}

function selectDeck(id: string | null) {
  void router.replace({ path: '/review', query: id ? { deckId: id } : {} })
}
</script>

<template>
  <section class="page review-page">
    <header class="page-intro">
      <h1>Review</h1>
      <p>Recall the English word, then rate how well you remembered it.</p>
    </header>

    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="roundError || overviewError" type="error" role="alert">
      Your local review data could not be loaded.
      <NButton text @click="reloadRound(); reloadOverview()">Try again</NButton>
    </NAlert>
    <NCard v-else-if="round?.session.status === 'active'" class="review-card">
      <div v-if="round.word" ref="focusTarget" tabindex="-1" class="review-recall" @keydown="onKeydown"
        @compositionstart="composing = true" @compositionend="composing = false" @focusout="composing = false">
        <p class="library-muted">Card {{ round.session.currentIndex + 1 }} of {{ round.session.entryIds.length }}
          · {{ round.word.card ? 'Due review' : 'First recall' }}</p>
        <template v-if="!revealed">
          <h2>Recall the English word</h2>
          <p class="review-meaning" lang="zh">{{ round.word.prompt }}</p>
          <NInput v-model:value="answer" :readonly="busy" placeholder="Type your recall (optional)" :input-props="{
            'aria-label': 'Type your recall', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
          }" />
          <div class="review-actions">
            <NButton type="primary" :disabled="busy" @click="reveal">Show answer</NButton>
            <span class="library-muted">Space to reveal when the answer field is out of focus</span>
          </div>
        </template>
        <template v-else>
          <h2 class="review-term">{{ round.word.entry.term }}</h2>
          <p class="review-meaning" lang="zh">{{ round.word.entry.meaning }}</p>
          <p v-if="round.word.entry.phonetic" class="library-muted">{{ round.word.entry.phonetic }}</p>
          <blockquote v-if="round.word.entry.example" class="review-example">{{ round.word.entry.example }}</blockquote>
          <ReviewPronunciation :term="round.word.entry.term" />
          <p v-if="spellCheck !== undefined" role="status">
            {{ spellCheck ? 'Your spelling matches.' : 'Your spelling differs.' }} Choose the rating that reflects your recall.
          </p>
          <div class="review-ratings" aria-label="Recall ratings">
            <div v-for="(rating, index) in reviewRatings" :key="rating">
              <NButton :disabled="busy" @click="rate(rating)">{{ ratingLabels[rating].label }}</NButton>
              <small>{{ index + 1 }} · {{ ratingLabels[rating].hint }}</small>
            </div>
          </div>
        </template>
      </div>
      <div v-else class="review-recall">
        <p role="status">Checking the remaining review cards…</p>
        <NButton v-if="error" :disabled="busy" @click="repair">Try again</NButton>
      </div>
      <div class="review-actions review-session-actions">
        <NButton :disabled="busy" @click="changeStatus('paused')">Pause</NButton>
        <NButton :disabled="busy" @click="changeStatus('abandoned')">End round</NButton>
      </div>
    </NCard>
    <template v-else-if="overview && round !== undefined">
      <NCard v-if="round?.session.status === 'paused'" class="review-card">
        <h2>Review paused</h2>
        <p>{{ round.rated }} rated in this round.</p>
        <div class="review-actions review-session-actions">
          <NButton type="primary" :disabled="busy" @click="changeStatus('active')">Resume review</NButton>
          <NButton :disabled="busy" @click="changeStatus('abandoned')">End round</NButton>
        </div>
      </NCard>
      <NCard class="review-card">
        <div class="review-recall">
          <template v-if="round?.session.status === 'completed'">
            <h2>Review round complete</h2>
            <p>{{ round.rated }} rated in this round.</p>
          </template>
          <NSelect :value="deckId ?? null" :options="deckOptions" clearable aria-label="Review deck"
            placeholder="All active decks" @update:value="selectDeck" />
          <dl class="review-counts">
            <div><dt>Due reviews</dt><dd>{{ overview.due }}</dd></div>
            <div><dt>Waiting for first recall</dt><dd>{{ overview.firstRecall }}</dd></div>
            <div><dt>Rated today</dt><dd>{{ overview.ratedToday }}</dd></div>
          </dl>
          <p v-if="!overview.due && !overview.firstRecall" class="library-muted">No words to review right now.</p>
          <p v-if="overview.nextDueAt !== undefined">
            Next review <time :datetime="new Date(overview.nextDueAt).toISOString()">{{ formatReviewTime(overview.nextDueAt) }}</time>
          </p>
          <div v-if="round?.session.status !== 'paused'">
            <NButton type="primary" :disabled="busy || !overview.due && !overview.firstRecall"
              @click="run(() => review.start(deckId))">Start review</NButton>
          </div>
        </div>
      </NCard>
    </template>
    <p v-else class="library-muted" aria-live="polite">Loading your reviews…</p>
  </section>
</template>

<style scoped>
.review-page, .review-recall { display: grid; gap: 16px; min-width: 0; }
.review-card { max-width: 760px; }
.review-recall:focus-visible { outline-offset: 5px; }
.review-meaning, .review-term, .review-example { white-space: pre-wrap; overflow-wrap: anywhere; }
.review-meaning { font-size: 1.25rem; }
.review-term { font-size: clamp(1.75rem, 6vw, 3rem); }
.review-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.review-session-actions { margin-top: 16px; }
.review-counts, .review-ratings { display: grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap: 12px; }
.review-counts dd { margin: 4px 0 0; font-size: 1.5rem; font-weight: 650; }
.review-ratings > div { display: grid; gap: 4px; align-content: start; }
.review-ratings small, .review-example { color: var(--muted); }
@media (max-width: 520px) {
  .review-actions > .n-button, .review-ratings .n-button { min-height: 42px; }
}
</style>
