<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NInputNumber, NProgress, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import type { Entry as EntryRecord } from '../../../shared/domain/library'
import type { LearnMode } from '../../../shared/domain/learning'
import { compareSpelling, isSpellingCorrect, normalizeSpelling } from '../../../shared/domain/learning'
import { writeDailyNewWords } from '../../api/client'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { useLibraryAction } from '../library/library-ui'
import { learn, type LearnSessionRecord } from './api'
import PronunciationButton from '../speech/PronunciationButton.vue'

const route = useRoute()
const router = useRouter()
const selectedDeckId = ref(typeof route.query.deckId === 'string' ? route.query.deckId : '')
const mode = ref<LearnMode>('copy')
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : undefined)
const { data: home, error: homeLoadError, reload: reloadHome } =
  useLibraryQuery(() => selectedDeckId.value || undefined, learn.getDailyState)
const { data: current, error: sessionLoadError, reload: reloadSession } =
  useLibraryQuery(sessionId, (id, signal) => id ? learn.getSession(id, signal) : Promise.resolve(null))
const { data: result } = useLibraryQuery(() => sessionId.value,
  (id, signal) => id ? learn.result(id, signal) : Promise.resolve(null))
const { busy, error, run } = useLibraryAction()
const input = ref('')
const inputElement = ref<InstanceType<typeof NInput>>()
const nextButton = ref<InstanceType<typeof NButton>>()
const composing = ref(false)
const localMessage = ref('')
const dailyWords = ref(10)
const activeWord = computed(() => current.value?.session.status === 'active' ? current.value.entry : undefined)
const wordKey = computed(() => activeWord.value && current.value
  ? current.value.session.sessionId + '/' + activeWord.value.id : undefined)
const expected = computed(() => activeWord.value?.term ?? '')
const lastSubmitted = computed(() => activeWord.value ? current.value?.session.currentLastSubmitted : undefined)
const submittedCorrectly = computed(() => !!lastSubmitted.value && isSpellingCorrect(expected.value, lastSubmitted.value))
const isCopy = computed(() => current.value?.session.mode === 'copy')
const answerVisible = computed(() => isCopy.value || current.value?.session.currentAssisted)
const meaning = computed(() => {
  const hint = activeWord.value?.meaning
  if (!hint || answerVisible.value) return hint
  return normalizeSpelling(hint).includes(normalizeSpelling(expected.value)) ? undefined : hint
})
const feedback = computed(() => {
  const answer = isCopy.value ? input.value : lastSubmitted.value
  return answer ? compareSpelling(expected.value, answer) : []
})
const activeDeck = computed(() => current.value && home.value?.decks
  .find((deck) => deck.id === current.value!.session.deckId))
const progressValue = computed(() => current.value
  ? Math.round(current.value.session.currentIndex / Math.max(current.value.session.entryIds.length, 1) * 100) : 0)
const eligibleCount = computed(() => home.value?.candidates.length ?? 0)
const repeatCount = computed(() => home.value?.practiceCandidates.length ?? 0)
const dailyRemaining = computed(() => Math.max(0, (home.value?.quota ?? 10) - (home.value?.completedToday ?? 0)))
const newWordCount = computed(() => Math.min(eligibleCount.value, dailyRemaining.value))
const deckOptions = computed(() => (home.value?.decks ?? []).map((deck) => ({ label: deck.name, value: deck.id })))
const learnHome = computed(() => !sessionId.value || current.value === null)
watch(() => home.value?.quota, (quota) => { if (quota !== undefined) dailyWords.value = quota })

watch(() => current.value?.session.mode, (value) => { if (value) mode.value = value }, { immediate: true })
watch([wordKey, lastSubmitted], ([key, answer], [previousKey]) => {
  if (key !== previousKey || submittedCorrectly.value) input.value = answer ?? ''
  if (key !== previousKey) {
    composing.value = false
    localMessage.value = ''
  }
})

watch([wordKey, submittedCorrectly, busy], async ([key, correct, pending]) => {
  if (!key || pending) return
  await nextTick()
  if (key !== wordKey.value || busy.value) return
  if (correct) nextButton.value?.$el.focus()
  else inputElement.value?.focus()
}, { flush: 'post' })

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.defaultPrevented) return
  const onNext = event.target === nextButton.value?.$el
  if (!onNext && event.target !== inputElement.value?.inputElRef) return
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
    || composing.value || event.isComposing || event.keyCode === 229) {
    if (onNext) event.preventDefault()
    return
  }
  event.preventDefault()
  if (event.repeat || busy.value) return
  if (submittedCorrectly.value) void finishWord('completed')
  else void submit()
}

function resolveInvalidWord() {
  const session = current.value?.session
  if (!session) return
  void run(() => learn.advanceInvalid(session.sessionId, session.revision))
}

let repairAttempted: typeof current.value
watch([current, busy], ([snapshot, pending]) => {
  if (pending || !snapshot?.invalidReason || snapshot === repairAttempted) return
  if (snapshot.invalidReason === 'archived' && snapshot.session.status === 'paused') return
  repairAttempted = snapshot
  resolveInvalidWord()
})

function startSession(deckId: string, sessionMode: LearnMode, candidates: EntryRecord[], newWords: boolean) {
  void run(async () => {
    const session = await learn.startSession(deckId, sessionMode, candidates.map(({ id }) => id), newWords)
    await router.push({ path: '/learn', query: { deckId: session.deckId, session: session.sessionId } })
  })
}

function beginNewWords(sessionMode: LearnMode) {
  const candidates = home.value?.candidates ?? []
  if (!selectedDeckId.value) { localMessage.value = 'Choose an active deck before starting.'; return }
  if (!candidates.length) { localMessage.value = 'There are no new words available in this deck today.'; return }
  startSession(selectedDeckId.value, sessionMode, candidates, true)
}

function beginPractice(sessionMode: LearnMode) {
  const candidates = home.value?.practiceCandidates ?? []
  if (selectedDeckId.value && candidates.length) startSession(selectedDeckId.value, sessionMode, candidates, false)
}

function continueSession(session: LearnSessionRecord) {
  void run(async () => {
    const resumed = await learn.continueSession(session.sessionId, session.revision)
    if (resumed) {
      await router.push({ path: '/learn', query: { deckId: resumed.deckId, session: resumed.sessionId } })
    }
  })
}

function abandonSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'abandoned', session.revision)
    await router.replace({ path: '/learn', query: selectedDeckId.value ? { deckId: selectedDeckId.value } : {} })
    localMessage.value = 'Your completed practice stays in your learning history.'
    await reloadHome()
  })
}

function pauseSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'paused', session.revision)
    await router.replace({ path: '/learn', query: { deckId: session.deckId, session: session.sessionId } })
    await reloadSession()
  })
}

function endSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'paused', session.revision)
    await router.push({ path: '/learn', query: { deckId: session.deckId } })
    await reloadHome()
  })
}

async function submit() {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || submittedCorrectly.value || busy.value || composing.value) return
  const answer = input.value
  if (!answer.trim()) { localMessage.value = 'Type your answer before submitting.'; return }
  localMessage.value = ''
  const attempt = await run(() => learn.recordAttempt(session.sessionId, entry.id, answer, session.revision))
  if (!attempt || wordKey.value !== session.sessionId + '/' + entry.id) return
  if (attempt.correct) {
    localMessage.value = attempt.assisted
      ? (attempt.first ? 'Correct on your first try after revealing the answer.' : 'Correct after revealing the answer.')
      : (attempt.first ? 'Correct on your first try.' : 'Correct. Keep going.')
  } else {
    localMessage.value = 'Not quite. Check the marked letters and try again.'
  }
}

async function finishWord(outcome: 'completed' | 'skipped') {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || busy.value || (outcome === 'completed') !== submittedCorrectly.value) return
  await run(() => learn.finishCurrent(session.sessionId, entry.id, outcome, session.revision))
}

async function markAssisted() {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || submittedCorrectly.value) return
  const saved = await run(() => learn.setAssisted(session.sessionId, entry.id, session.revision))
  if (saved && wordKey.value === session.sessionId + '/' + entry.id) {
    localMessage.value = 'Answer revealed. This answer will be marked as assisted.'
  }
}

function switchToCopy(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setMode(session.sessionId, 'copy', session.revision)
  })
}

async function saveDailyWords(value: number | null) {
  if (value === null || busy.value) return
  const saved = await run(async () => { await writeDailyNewWords(value); return value })
  if (saved) { dailyWords.value = saved; await reloadHome() }
}

</script>

<template>
  <section class="page learn-page">
    <RouterLink v-if="sessionId" class="library-back" to="/learn">{{ t('← Learn home') }}</RouterLink>
    <header class="page-intro"><h1>{{ t('Learn') }}</h1><p>{{ t('Meet new words and get comfortable using them.') }}</p></header>
    <template v-if="learnHome">
      <NAlert v-if="homeLoadError" type="error" role="alert">
        {{ t('Your learning data could not be loaded from the server.') }} <NButton text @click="reloadHome">{{ t('Try again') }}</NButton>
      </NAlert>
      <p v-else-if="!home" class="library-muted" aria-live="polite">{{ t('Loading your learning data…') }}</p>
      <template v-else>
        <NCard class="learn-start-card">
          <div class="learn-card-content">
            <p class="learn-overline">{{ t('{count} of {quota} new words completed today', { count: home.completedToday, quota: home.quota }) }}</p>
            <NProgress type="line" :percentage="Math.min(100, Math.round(home.completedToday / home.quota * 100))"
              :show-indicator="false" :aria-label="t('Today\'s first learning progress')" />
            <label for="learn-deck">{{ t('Word deck') }}</label>
            <NSelect v-model:value="selectedDeckId" :options="deckOptions" clearable
              :placeholder="t('Choose a deck')" :aria-label="t('Choose a deck')" />
            <div class="learn-quota-row">
              <div><h2>{{ t('Daily new words') }}</h2><p>{{ t('One shared limit across your active decks.') }}</p></div>
              <NInputNumber :value="dailyWords" :min="1" :max="100" :step="1" :disabled="busy"
                :aria-label="t('Daily new words')" @update:value="saveDailyWords" />
            </div>
          </div>
        </NCard>
        <NCard v-if="home.activeSession" class="learn-session-choice">
          <h2>{{ t('Continue your session?') }}</h2>
          <p class="library-muted">{{ t('{completed} first completions · word {current} of {total} · {mode}', {
              completed: home.activeSession.firstCompletedEntryIds.length,
              current: Math.min(home.activeSession.currentIndex + 1, home.activeSession.entryIds.length),
              total: home.activeSession.entryIds.length, mode: t(home.activeSession.mode === 'copy' ? 'Copy' : 'Dictation'),
            }) }}
          </p>
          <div class="learn-actions">
            <NButton type="primary" :disabled="busy" @click="continueSession(home.activeSession)">{{ t('Continue session') }}</NButton>
            <NButton :disabled="busy" @click="abandonSession(home.activeSession)">{{ t('End and save session') }}</NButton>
          </div>
        </NCard>
        <NCard v-else-if="home.decks.length" class="learn-session-choice">
          <h2>{{ dailyRemaining ? t('Ready for a few new words?') : t('Today’s new word limit is complete') }}</h2>
          <p class="library-muted">{{ selectedDeckId
            ? t('{eligible} new words available · {remaining} places remaining today', { eligible: eligibleCount, remaining: dailyRemaining })
            : t('Choose a deck to see today’s available new words.') }}</p>
          <div class="learn-mode-picker">
            <span>{{ t('Practice mode') }}</span>
            <NRadioGroup :value="mode" name="learn-mode" :aria-label="t('Practice mode')"
              @update:value="(value) => { mode = value as LearnMode }">
              <NRadioButton value="copy">{{ t('Copy') }}</NRadioButton>
              <NRadioButton value="dictation">{{ t('Dictation') }}</NRadioButton>
            </NRadioGroup>
          </div>
          <div class="learn-actions">
            <NButton type="primary" :disabled="!selectedDeckId || !eligibleCount || !dailyRemaining" @click="beginNewWords(mode)">
              {{ t(newWordCount === 1 ? 'Learn {count} new word' : 'Learn {count} new words', { count: newWordCount }) }}
            </NButton>
            <NButton v-if="selectedDeckId && repeatCount" secondary @click="beginPractice(mode)">
              {{ t(repeatCount === 1 ? 'Practice {count} learned word' : 'Practice {count} learned words', { count: repeatCount }) }}
            </NButton>
          </div>
        </NCard>
        <NEmpty v-else :description="t('Create a deck in Library to start learning.')">
          <template #extra><RouterLink to="/library" class="library-back">{{ t('Open Library') }}</RouterLink></template>
        </NEmpty>
        <NAlert v-if="error" type="error" role="alert">
            {{ translateError(error) }} <NButton text @click="reloadHome(); reloadSession()">{{ t('Reload Learn') }}</NButton>
          </NAlert>
        <NAlert v-if="localMessage" type="info" role="status">{{ t(localMessage) }}</NAlert>
      </template>
    </template>
    <NAlert v-else-if="sessionLoadError" type="error" role="alert">
      {{ t('This session could not be loaded.') }} <NButton text @click="reloadSession">{{ t('Try again') }}</NButton>
    </NAlert>
    <p v-else-if="sessionId && !current" class="library-muted" aria-live="polite">{{ t('Restoring your learning session…') }}</p>
    <NCard v-else-if="current?.session.status === 'completed' && result?.session.status === 'completed'" class="learn-result-card">
      <p class="learn-overline">{{ t('Session complete') }}</p>
      <h2>{{ t('Words you worked through') }}</h2>
      <div class="learn-result-grid">
        <div><strong>{{ result.completed }}</strong><span>{{ t('completed') }}</span></div>
        <div><strong>{{ result.firstCompleted }}</strong><span>{{ t('first learning') }}</span></div>
        <div><strong>{{ result.firstTryCorrect }}</strong><span>{{ t('unassisted first try correct') }}</span></div>
        <div><strong>{{ result.skipped }}</strong><span>{{ t('skipped') }}</span></div>
      </div>
      <p>{{ t(result.attempts === 1 ? '{count} submitted answer' : '{count} submitted answers', { count: result.attempts }) }}
        · {{ t(result.assisted === 1 ? '{count} assisted answer' : '{count} assisted answers', { count: result.assisted }) }}</p>
      <div class="learn-actions">
        <NButton type="primary" @click="router.push({ path: '/learn', query: selectedDeckId ? { deckId: selectedDeckId } : {} })">{{ t('Continue learning') }}</NButton>
        <NButton @click="router.push('/library')">{{ t('Return to Library') }}</NButton>
      </div>
    </NCard>
    <template v-else-if="current?.session">
      <NAlert v-if="current.invalidReason === 'archived'" type="warning">
        {{ t('This deck is archived. Restore it in Library to continue.') }}
        <RouterLink :to="{ path: '/library/' + current.session.deckId }" class="library-back">{{ t('Open deck') }}</RouterLink>
      </NAlert>
      <NAlert v-else-if="current.session.status === 'abandoned'" type="info">
        {{ t('This session can no longer be continued.') }} <RouterLink to="/learn">{{ t('Return to Learn') }}</RouterLink>
      </NAlert>
      <NAlert v-else-if="current.invalidReason" :type="error ? 'error' : 'info'">
        {{ translateError(error || 'Checking the remaining words…') }}
        <NButton text :disabled="busy" @click="resolveInvalidWord">{{ t('Try again') }}</NButton>
      </NAlert>
      <NAlert v-else-if="current.session.status === 'paused'" type="info">
        {{ t('Session paused.') }} <NButton text @click="continueSession(current.session)">{{ t('Resume') }}</NButton>
      </NAlert>
      <NCard v-else-if="activeWord && current.entry" class="learn-card" @keydown="onKeydown">
        <div class="learn-session-top">
          <span>{{ current.session.mode === 'copy' ? t('Copy · 跟写') : t('Dictation · 听写') }}</span>
          <span>{{ current.session.currentIndex + 1 }} / {{ current.session.entryIds.length }}</span>
        </div>
        <NProgress type="line" :percentage="progressValue" :show-indicator="false" :aria-label="t('Session progress')" />
        <p v-if="meaning" class="learn-meaning">{{ meaning }}</p>
        <p v-else-if="!current.entry.meaning" class="learn-meaning learn-muted">{{ t('Meaning not added yet') }}</p>
        <p v-if="answerVisible && current.entry.phonetic" class="learn-phonetic">{{ current.entry.phonetic }}</p>
        <p v-if="!isCopy && answerVisible" class="learn-overline">{{ t('Answer revealed') }}</p>
        <h2 v-if="answerVisible" class="learn-term">{{ current.entry.term }}</h2>
        <p v-if="answerVisible && current.entry.explanation" class="library-muted library-preserve">{{ current.entry.explanation }}</p>
        <PronunciationButton :entry-id="activeWord.id" :revision="activeWord.revision" :scope="wordKey + '/' + current.session.mode"
          :disabled="busy" :preload="!isCopy" :label="isCopy ? 'Play pronunciation' : 'Play English pronunciation'" />
        <p v-if="current.session.mode === 'dictation'" class="library-muted">
          {{ t('Listen to the word. The English example stays hidden during dictation.') }}
        </p>
        <blockquote v-if="current.session.mode === 'copy' && current.entry.example" class="learn-example">
          {{ current.entry.example }}
        </blockquote>
        <div class="learn-practice-area">
          <NButton v-if="!isCopy" text :disabled="busy" @click="switchToCopy(current.session)">{{ t('Switch to Copy') }}</NButton>
          <NInput ref="inputElement" v-model:value="input" :readonly="busy" :disabled="submittedCorrectly" :input-props="{
              'aria-label': isCopy ? t('Copy the word') : t('Type the dictated word'),
              autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'done',
              onCompositionstart: () => { composing = true }, onCompositionend: () => { composing = false },
              onBlur: () => { composing = false },
            }" :placeholder="t('Type your answer')" />
          <div v-if="feedback.length" class="learn-spelling" aria-live="polite"
            :aria-label="feedback.map((part) => part.actual + ': ' + t(part.status)).join(', ')">
            <span v-for="(part, index) in feedback" :key="index" :class="'letter-' + part.status"
              aria-hidden="true">{{ part.actual === ' ' ? '·' : part.actual }}</span>
          </div>
          <p class="learn-keyboard-hint">{{ submittedCorrectly ? t('Press Enter for the next word.') : t('Press Enter to check spelling.') }}</p>
          <NAlert v-if="localMessage" :type="submittedCorrectly ? 'success' : 'info'" role="status">{{ t(localMessage) }}</NAlert>
          <NAlert v-if="error" type="error" role="alert">
            {{ translateError(error) }} <NButton text @click="reloadHome(); reloadSession()">{{ t('Reload Learn') }}</NButton>
          </NAlert>
          <NAlert v-if="current.entry.meaning.trim() === ''" type="info">
            {{ t('This word needs a meaning. Spelling practice remains available.') }}
          </NAlert>
        </div>
        <div class="learn-actions learn-session-actions">
          <NButton v-if="!submittedCorrectly" type="primary"
            :disabled="busy || !input.trim() || current.session.status !== 'active'" @click="submit">{{ t('Check spelling') }}</NButton>
          <NButton v-else ref="nextButton" type="primary" :disabled="busy" @click="finishWord('completed')">{{ t('Next word') }}</NButton>
          <NButton v-if="current.session.mode === 'dictation' && !submittedCorrectly && !current.session.currentAssisted"
            :disabled="busy" @click="markAssisted">{{ t('Reveal answer') }}</NButton>
          <NButton v-if="!submittedCorrectly" :disabled="busy || current.session.status !== 'active'" @click="finishWord('skipped')">{{ t('Skip word') }}</NButton>
          <NButton v-if="current.session.status === 'active'" :disabled="busy" @click="pauseSession(current.session)">{{ t('Pause') }}</NButton>
          <NButton :disabled="busy" @click="endSession(current.session)">{{ t('End session') }}</NButton>
        </div>
        <p v-if="activeDeck && answerVisible" class="learn-deck-name">{{ t('From {deck}', { deck: activeDeck.name }) }}</p>
      </NCard>
    </template>
    <p class="learn-distinction">{{ t('Spelling practice records exposure and attempts. It never schedules an FSRS review.') }}</p>
  </section>
</template>
