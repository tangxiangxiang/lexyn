<script setup lang="ts">
import DictionaryMeaningView from '../dictionary/DictionaryMeaningView.vue'
import AppIcon from '../../components/AppIcon.vue'
import SessionMenu from '../../components/SessionMenu.vue'
import { pronunciationAccent } from '../../ui/pronunciationAccent'
import { t, translateError } from '../../i18n/useI18n'
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton, NProgress, NSelect } from 'naive-ui'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { compareSpelling, isSpellingCorrect, normalizeSpelling } from '../../../shared/domain/learning'
import { reviewRatings, type ReviewRating } from '../../../shared/domain/review'
import { hasFinalMeaning } from '../../../shared/domain/dictionary'
import PronunciationButton from '../speech/PronunciationButton.vue'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { ApiError } from '../../api/client'
import SpellingFeedback from '../spelling/SpellingFeedback.vue'
import ReviewRecallInput from './ReviewRecallInput.vue'
import { allStudyRoute } from '../learn/api'
import { review, reviewSessionRoute } from './api'
import { formatReviewTime, useReviewOverview } from './useReviewOverview'

const route = useRoute()
const router = useRouter()
const deckId = computed(() => typeof route.query.deckId === 'string' ? route.query.deckId : undefined)
const listId = computed(() => typeof route.query.listId === 'string' ? route.query.listId : undefined)
const { data: overview, error: overviewError, reload: reloadOverview } = useReviewOverview(deckId, false, listId)
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : undefined)
const flow = computed(() => typeof route.query.flow === 'string' ? route.query.flow : undefined)
const { data: round, error: roundError, reload: reloadRound } = useLibraryQuery(
  () => [deckId.value, sessionId.value, listId.value] as const, ([deck, id, list], signal) => review.session(deck, id, signal, list),
  ([deck, id, list]) => [deck, id, list].join('/'),
)
const { data: open, error: openError, reload: reloadOpen } = useLibraryQuery(() => null, (_, signal) => review.open(signal))
const conflict = computed(() => open.value && (open.value.deckId !== deckId.value || open.value.listId !== listId.value) ? open.value : undefined)
const deckOptions = computed(() => overview.value?.decks.map(({ id, name }) => ({ label: name, value: id })) ?? [])
const answer = ref('')
const recallMode = ref<'mind' | 'spell'>('mind')
const busy = ref(false)
const error = ref('')
const composing = ref(false)
const focusTarget = ref<HTMLElement>()
const cardKey = computed(() => {
  const session = round.value?.session
  return session?.status === 'active' && session.currentCardId
    ? [session.sessionId, session.currentCardId, round.value?.word?.entryRevision].join('/') : undefined
})
const progressValue = computed(() => {
  const session = round.value?.session
  return session ? Math.round(session.currentIndex / Math.max(1, session.total) * 100) : 0
})
const revealed = computed(() => round.value?.revealed ?? false)
const spellCheck = computed(() => {
  const word = round.value?.word
  if (!revealed.value || !word?.answer || !answer.value.trim()) return undefined
  return isSpellingCorrect(word.answer.term, answer.value)
})
const ratingLabels = {
  again: { label: 'Again', hint: 'Could not recall' },
  hard: { label: 'Hard', hint: 'Recalled with effort' },
  good: { label: 'Good', hint: 'Recalled normally' },
  easy: { label: 'Easy', hint: 'Recalled easily' },
} satisfies Record<ReviewRating, { label: string; hint: string }>

const feedback = computed(() => {
  const term = round.value?.word?.answer?.term
  return revealed.value && term && answer.value.trim() ? compareSpelling(normalizeSpelling(term), normalizeSpelling(answer.value)) : []
})

watch([round, flow], ([current, id]) => {
  const session = current?.session
  if (id && session?.studyFlowId === id && session.deckId && (session.status === 'completed' || session.status === 'abandoned')) {
    void router.replace(allStudyRoute(session.deckId, id))
  }
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
    if (cause instanceof ApiError && cause.status === 409) await refresh()
    error.value = cause instanceof Error ? cause.message : 'The review could not be saved. Try again.'
  } finally {
    busy.value = false
  }
}

function repair() {
  const session = round.value?.session
  if (session) void run(() => review.repair(session.sessionId, session.revision))
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
  void run(() => review.reveal(session.sessionId, cardId, word.entryRevision, session.revision))
}

function rate(rating: ReviewRating) {
  const session = round.value?.session
  const cardId = session?.currentCardId
  if (!session || !cardId || !revealed.value || composing.value) return
  void run(() => review.score(session.sessionId, cardId, rating, session.revision))
}

function changeStatus(status: 'active' | 'paused' | 'abandoned') {
  const session = round.value?.session
  if (session) void run(() => review.setStatus(session.sessionId, status, session.revision))
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

async function refresh() {
  await Promise.all([reloadRound(), reloadOverview(), reloadOpen()])
}

async function startReview(deck: string | undefined, list?: string) {
  const next = deck && list ? await review.startList(deck, list) : await review.start(deck, true)
  if (next.kind === 'round') await router.replace(reviewSessionRoute(next.round.session))
  else await refresh()
}

function endExisting() {
  const existing = conflict.value
  if (!existing) return
  const deck = deckId.value
  const list = listId.value
  void run(async () => {
    await review.setStatus(existing.sessionId, 'abandoned', existing.revision)
    await startReview(deck, list)
  })
}

function selectDeck(id: string | null) {
  void router.replace({ path: '/review', query: id ? { deckId: id } : {} })
}
</script>

<template>
  <section class="page review-page" :class="{ 'review-active': round?.session.status === 'active' }">
    <header class="page-toolbar review-toolbar">
      <RouterLink class="icon-control spell-session-back" to="/study" :aria-label="t('Back to study')">
        <AppIcon name="chevronLeft" />
      </RouterLink>
      <h1>{{ t('Review') }}</h1>
      <SessionMenu v-if="round?.session.status === 'active'">
        <NButton text :disabled="busy" @click="changeStatus('paused')">{{ t('Pause') }}</NButton>
        <NButton text :disabled="busy" @click="changeStatus('abandoned')">{{ t('End round') }}</NButton>
      </SessionMenu>
    </header>

    <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }} <NButton text @click="refresh()">{{ t('Reload session') }}</NButton></NAlert>
    <NAlert v-if="roundError || overviewError || openError" type="error" role="alert">
      {{ t('Your review data could not be loaded from the server.') }}
      <NButton text @click="refresh()">{{ t('Try again') }}</NButton>
    </NAlert>
    <article v-else-if="round?.session.status === 'active'" class="review-study-card">
      <div v-if="round.word" ref="focusTarget" tabindex="-1" class="review-recall" @keydown="onKeydown"
        @compositionstart="composing = true" @compositionend="composing = false" @focusout="composing = false">
        <div class="review-position">
          <NProgress type="circle" :percentage="progressValue" :show-indicator="false" :aria-label="t('Session progress')" />
          <p>{{ t('Card {current} of {total}', { current: round.session.currentIndex + 1, total: round.session.total }) }}
            · {{ round.word.card ? t('Due review') : t('First recall') }}</p>
        </div>
        <template v-if="!revealed">
          <div class="review-prompt">
            <h2>{{ t('Recall the English word') }}</h2>
            <p class="review-meaning" lang="zh">{{ round.word.prompt }}</p>
          </div>
          <div class="review-actions" role="group" :aria-label="t('Recall method')">
            <NButton secondary :aria-pressed="recallMode === 'mind'" :disabled="busy" @click="recallMode = 'mind'; answer = ''">{{ t('Think of the word') }}</NButton>
            <NButton secondary :aria-pressed="recallMode === 'spell'" :disabled="busy" @click="recallMode = 'spell'">{{ t('Spell the word') }}</NButton>
          </div>
          <ReviewRecallInput v-if="recallMode === 'spell'" v-model="answer" :disabled="busy" @submit="reveal" />
          <div class="review-actions">
            <NButton v-if="recallMode === 'spell' && answer.trim()" :disabled="busy" @click="reveal">{{ t('Submit spelling') }}</NButton>
            <NButton type="primary" :disabled="busy" @click="reveal">{{ t('Show answer') }}</NButton>
            <span class="review-shortcut library-muted">{{ t('Space to reveal when the answer field is out of focus') }}</span>
          </div>
        </template>
        <template v-else-if="round.word.answer">
          <h2 class="review-term">{{ round.word.answer.term }}</h2>
          <div class="spell-pronunciation">
            <PronunciationButton :entry-id="round.word.answer.id" :revision="round.word.answer.revision" label="Play pronunciation"
              :phonetics="round.word.answer.phonetics" :legacy-phonetic="round.word.answer.phonetic" :accent="pronunciationAccent" />
          </div>
          <DictionaryMeaningView v-if="hasFinalMeaning(round.word.answer.dictionaryMeaning)" :meaning="round.word.answer.dictionaryMeaning!" />
          <p v-else class="review-meaning" lang="zh">{{ round.word.answer.meaning }}</p>
          <p v-if="spellCheck !== undefined">{{ t('Your spelling') }} · <b>{{ answer }}</b></p>
          <SpellingFeedback :feedback="feedback" />
          <p v-if="spellCheck !== undefined" role="status">
            {{ spellCheck ? t('Your spelling matches.') : t('Your spelling differs.') }} {{ t('Choose the rating that reflects your recall.') }}
          </p>
          <p v-else class="library-muted">{{ t('Rate what you recalled before seeing the answer.') }}</p>
          <div class="review-ratings" role="group" :aria-label="t('Recall ratings')">
            <div v-for="(rating, index) in reviewRatings" :key="rating">
              <NButton :disabled="busy" :aria-keyshortcuts="String(index + 1)" :aria-describedby="'rating-' + rating"
                @click="rate(rating)">{{ t(ratingLabels[rating].label) }}</NButton>
              <small :id="'rating-' + rating">{{ t(ratingLabels[rating].hint) }}</small>
            </div>
          </div>
        </template>
      </div>
      <div v-else class="review-recall">
        <p role="status">{{ t('Checking the remaining review cards…') }}</p>
        <NButton v-if="error" :disabled="busy" @click="repair">{{ t('Try again') }}</NButton>
      </div>
    </article>
    <template v-else-if="overview && round !== undefined">
      <section v-if="round?.session.status === 'paused'" class="review-status">
        <h2>{{ t('Review paused') }}</h2>
        <p>{{ t('{count} rated in this round.', { count: round.rated }) }}</p>
        <div class="review-actions">
          <NButton type="primary" :disabled="busy" @click="changeStatus('active')">{{ t('Resume review') }}</NButton>
          <NButton :disabled="busy" @click="changeStatus('abandoned')">{{ t('End round') }}</NButton>
        </div>
      </section>
      <section v-if="conflict" class="review-status">
        <h2>{{ t('Another review round is open') }}</h2>
        <p>{{ t('Continue that session or end it before starting here.') }}</p>
        <div class="review-actions">
          <NButton type="primary" :disabled="busy" @click="run(() => startReview(conflict?.deckId, conflict?.listId))">{{ t('Continue existing session') }}</NButton>
          <NButton :disabled="busy" @click="endExisting">{{ t('End existing session and start') }}</NButton>
        </div>
      </section>
      <section class="review-overview">
        <div class="review-recall">
          <template v-if="round?.session.status === 'completed'">
            <h2>{{ t('Review round complete') }}</h2>
            <div class="learn-result-grid study-result-grid">
              <div><strong>{{ round.rated }}</strong><span>{{ t('Cards rated') }}</span></div>
              <div><strong>{{ round.dueRated }}</strong><span>{{ t('Due reviews') }}</span></div>
              <div><strong>{{ round.firstRecallRated }}</strong><span>{{ t('First recall') }}</span></div>
            </div>
            <RouterLink to="/study" class="library-back">{{ t('Back to study') }}</RouterLink>
          </template>
          <template v-else-if="round?.session.status === 'abandoned'">
            <h2>{{ t('Session ended') }}</h2>
            <p>{{ t('{count} rated in this round.', { count: round.rated }) }}</p>
          </template>
          <NSelect :value="deckId ?? null" :options="deckOptions" clearable :aria-label="t('Review deck')"
            :placeholder="t('All active decks')" @update:value="selectDeck" />
          <dl class="review-counts">
            <div><dt>{{ t('Due reviews') }}</dt><dd>{{ overview.due }}</dd></div>
            <div><dt>{{ t('Waiting for first recall') }}</dt><dd>{{ overview.firstRecall }}</dd></div>
            <div><dt>{{ t('Rated today') }}</dt><dd>{{ overview.ratedToday }}</dd></div>
          </dl>
          <p v-if="!overview.due && !overview.firstRecall" class="library-muted">{{ t('No words to review right now.') }}</p>
          <p v-if="overview.nextDueAt !== undefined">
            {{ t('Next review') }} <time :datetime="new Date(overview.nextDueAt).toISOString()">{{ formatReviewTime(overview.nextDueAt) }}</time>
          </p>
          <div v-if="round?.session.status !== 'paused' && !conflict">
            <NButton type="primary" :disabled="busy || !overview.due && !overview.firstRecall"
              @click="run(() => startReview(deckId, listId))">{{ t('Start review') }}</NButton>
          </div>
        </div>
      </section>
    </template>
    <p v-else class="library-muted" aria-live="polite">{{ t('Loading your reviews…') }}</p>
  </section>
</template>

<style scoped>
.review-page { display: grid; gap: 20px; }
.review-toolbar { margin-block-end: 4px; }
.review-toolbar .session-menu { grid-column: 3; }
.review-recall, .review-status, .review-overview { display: grid; gap: 16px; min-width: 0; }
.review-status { padding-block-end: 20px; border-bottom: 1px solid var(--line); }
.review-status h2, .review-overview h2 { font-size: 1.2rem; font-weight: 650; }
.review-actions [aria-pressed="true"] { background: var(--accent-surface); }
.review-recall:focus { outline: none; }
.review-active .review-recall { display: flex; flex-direction: column; min-height: 65dvh; }
.review-position { display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--muted); font-size: .85rem; }
.review-position .n-progress { width: 22px; flex: none; }
.review-prompt { display: grid; justify-items: center; gap: 10px; padding-block: clamp(20px, 7dvh, 64px); text-align: center; }
.review-prompt h2 { color: var(--muted); font-size: .9rem; font-weight: 550; }
.review-meaning, .review-term { white-space: pre-wrap; overflow-wrap: anywhere; }
.review-meaning { font-size: clamp(1.1rem, 3vw, 1.45rem); line-height: 1.55; }
.review-term { margin-block-start: clamp(12px, 5dvh, 45px); font-size: clamp(2.25rem, 8vw, 4.75rem); font-weight: 580; letter-spacing: -.045em; text-align: center; }
.review-recall .spell-pronunciation { justify-content: center; }
.review-study-card .review-actions { justify-content: center; }
.review-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.review-actions .n-button, .review-ratings .n-button, .review-overview .n-button { min-height: 44px; }
.review-actions .n-button, .review-overview .n-button { border-radius: 999px; }
.review-counts, .review-ratings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.review-counts { margin: 0; padding: 14px 12px; border-radius: var(--panel-radius); background: var(--panel); text-align: center; }
.review-counts dt, .review-ratings small { color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.review-counts dd { margin: 4px 0 0; font-size: 1.65rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.review-ratings { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-block-start: auto; padding-block-start: 12px; }
.review-ratings > div { display: grid; gap: 6px; min-width: 0; align-content: start; text-align: center; }
.review-ratings .n-button { background: var(--glass); padding-inline: 4px; }
@media (pointer: coarse) {
  .review-shortcut { display: none; }
}
@media (max-width: 375px) {
  .review-ratings { gap: 4px; }
}
</style>
