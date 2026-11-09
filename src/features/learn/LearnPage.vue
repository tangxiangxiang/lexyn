<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NInputNumber, NProgress, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import type { EntryRecord, LearnSessionRecord } from '../../db/local'
import type { LearnMode } from '../../../shared/domain/learning'
import { compareSpelling, isSpellingCorrect } from '../../../shared/domain/learning'
import { db, readDailyNewWords, writeDailyNewWords } from '../../db/local'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { useLibraryAction } from '../library/library-ui'
import { createLearnRepository } from './repository'
import { useSpeech } from './speech'

const learn = createLearnRepository(db)
const route = useRoute()
const router = useRouter()
const selectedDeckId = ref(typeof route.query.deckId === 'string' ? route.query.deckId : '')
const mode = ref<LearnMode>('copy')
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : undefined)
const { data: home, error: homeLoadError, reload: reloadHome } =
  useLibraryQuery(() => selectedDeckId.value || undefined, (deckId) => learn.getDailyState(deckId))
const { data: current, error: sessionLoadError, reload: reloadSession } =
  useLibraryQuery(sessionId, (id) => id ? learn.getSession(id) : Promise.resolve(null))
const { data: result } = useLibraryQuery(() => sessionId.value,
  (id) => id ? learn.result(id) : Promise.resolve(null))
const { busy, error, run } = useLibraryAction()
const input = ref('')
const inputElement = ref<HTMLElement>()
const composing = ref(false)
const localMessage = ref('')
const dailyWords = ref(10)
const expected = computed(() => current.value?.entry?.term ?? '')
const speech = useSpeech(expected, () => current.value?.session.ttsVoicesAvailable)
const speechAvailable = speech.available
const speechSpeaking = speech.speaking
const speechError = speech.error
const spelling = computed(() => compareSpelling(expected.value, input.value))
const submittedCorrectly = ref(false)
const activeDeck = computed(() => current.value && home.value?.decks
  .find((deck) => deck.id === current.value!.session.deckId))
const progressValue = computed(() => current.value
  ? Math.round(current.value.session.currentIndex / Math.max(current.value.session.entryIds.length, 1) * 100) : 0)
const eligibleCount = computed(() => home.value?.candidates.length ?? 0)
const repeatCount = computed(() => home.value?.practiceCandidates.length ?? 0)
const dailyRemaining = computed(() => Math.max(0, (home.value?.quota ?? 10) - (home.value?.completedToday ?? 0)))
const deckOptions = computed(() => (home.value?.decks ?? []).map((deck) => ({ label: deck.name, value: deck.id })))
const learnHome = computed(() => !sessionId.value || (!current.value?.session && !sessionLoadError.value && !result.value?.session))
let enterListener: ((event: KeyboardEvent) => void) | undefined

onMounted(async () => { dailyWords.value = await readDailyNewWords() })

watch(() => current.value?.session.sessionId, () => {
  const session = current.value?.session
  if (!session) return
  if (route.query.session !== session.sessionId) {
    void router.replace({ path: '/learn', query: { deckId: session.deckId, session: session.sessionId } })
  }
}, { flush: 'post' })

let focusedEntryId: string | undefined
watch(() => current.value?.entry?.id, async (entryId) => {
  if (!entryId || entryId === focusedEntryId) return
  focusedEntryId = entryId
  input.value = ''
  submittedCorrectly.value = false
  await nextTick()
  focusInput()
}, { flush: 'post' })

watch(() => current.value?.session.mode, (value) => { if (value) mode.value = value }, { immediate: true })
watch(() => current.value?.session.currentLastSubmitted, (answer) => {
  if (!answer) return
  input.value = answer
  submittedCorrectly.value = isSpellingCorrect(expected.value, answer)
}, { flush: 'post' })

function focusInput() {
  const root = inputElement.value
  const element = root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement
    ? root : root?.querySelector('input, textarea');
  (element as HTMLElement | null)?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || composing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (submittedCorrectly.value) void completeWord()
  else void submit()
}

function setInputElement(element: unknown) {
  if (element instanceof HTMLElement) inputElement.value = element
  else if (element && typeof element === 'object' && '$el' in element && element.$el instanceof HTMLElement) {
    inputElement.value = element.$el
  }
}

watch(inputElement, (element, previous) => {
  if (previous && enterListener) previous.removeEventListener('keydown', enterListener)
  if (!element) return
  enterListener = onKeydown
  element.addEventListener('keydown', enterListener)
}, { flush: 'post' })
onUnmounted(() => {
  if (inputElement.value && enterListener) inputElement.value.removeEventListener('keydown', enterListener)
})

function startSession(deckId: string, sessionMode: LearnMode, candidates: EntryRecord[], newWords: boolean) {
  void run(async () => {
    const session = await learn.startSession(deckId, sessionMode, candidates.map(({ id }) => id), newWords)
    await router.push({ path: '/learn', query: { deckId, session: session.sessionId } })
    await reloadSession()
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
    const resumed = await learn.continueSession(session.sessionId)
    if (resumed) {
      await router.push({ path: '/learn', query: { deckId: resumed.deckId, session: resumed.sessionId } })
      await reloadSession()
    }
  })
}

function abandonSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'abandoned')
    await router.replace({ path: '/learn', query: selectedDeckId.value ? { deckId: selectedDeckId.value } : {} })
    localMessage.value = 'Your completed practice stays in your learning history.'
    await reloadHome()
  })
}

function pauseSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'paused')
    await router.replace({ path: '/learn', query: { deckId: session.deckId, session: session.sessionId } })
    await reloadSession()
  })
}

function endSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'paused')
    await router.push({ path: '/learn', query: { deckId: session.deckId } })
    await reloadHome()
  })
}

async function submit() {
  const session = current.value?.session
  const entry = current.value?.entry
  if (!session || !entry || session.status !== 'active' || submittedCorrectly.value || busy.value) return
  const answer = input.value
  if (!answer.trim()) { localMessage.value = 'Type your answer before submitting.'; return }
  localMessage.value = ''
  const correct = isSpellingCorrect(entry.term, answer)
  const attempt = await run(() => learn.recordAttempt(session.sessionId, answer, correct))
  if (!attempt) return
  if (correct) {
    submittedCorrectly.value = true
    localMessage.value = attempt.first ? 'Correct on your first try.' : 'Correct. Keep going.'
  } else {
    localMessage.value = 'Not quite. Check the marked letters and try again.'
  }
  await reloadSession()
}

async function completeWord() {
  const session = current.value?.session
  if (!session || session.status !== 'active' || busy.value || !submittedCorrectly.value) return
  const saved = await run(() => learn.finishCurrent(session.sessionId, 'completed', Date.now(), session.currentIndex))
  if (saved?.error) {
    localMessage.value = saved.error === 'archived'
      ? 'This deck was archived. Restore it in Library to continue.'
      : 'This word was removed. The session is paused so you can safely return to Library.'
  } else if (saved?.event) {
    submittedCorrectly.value = false
    localMessage.value = ''
  }
  await reloadSession()
  await reloadHome()
}

async function skipWord() {
  const session = current.value?.session
  if (!session || session.status !== 'active' || busy.value) return
  const saved = await run(() => learn.finishCurrent(session.sessionId, 'skipped', Date.now(), session.currentIndex))
  if (saved?.error) {
    localMessage.value = saved.error === 'archived' ? 'This deck was archived. Restore it in Library to continue.'
      : 'This word was removed. The session is paused so you can safely return to Library.'
  } else if (saved?.event) {
    submittedCorrectly.value = false
    localMessage.value = 'Word skipped. It will remain available for a future new word session.'
  }
  await reloadSession()
  await reloadHome()
}

async function markAssisted() {
  const session = current.value?.session
  if (!session || session.status !== 'active') return
  const saved = await run(async () => { await learn.setAssisted(session.sessionId); return true })
  if (saved) {
    localMessage.value = 'Answer revealed. This answer will be marked as assisted.'
    await reloadSession()
  }
}

function switchToCopy(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setMode(session.sessionId, 'copy')
    await reloadSession()
  })
}

async function saveDailyWords(value: number | null) {
  if (value === null || busy.value) return
  const saved = await run(async () => { await writeDailyNewWords(value); return value })
  if (saved) { dailyWords.value = saved; await reloadHome() }
}

function updateVoicesAvailable(available: boolean) {
  const session = current.value?.session
  if (session?.mode === 'dictation') void learn.setVoicesAvailable(session.sessionId, available)
}
watch(speech.available, updateVoicesAvailable)

function playPronunciation() {
  if (!speech.available.value) return
  speech.speak()
}

const feedback = computed(() => compareSpelling(expected.value, input.value))
</script>

<template>
  <section class="page learn-page">
    <RouterLink v-if="sessionId" class="library-back" to="/learn">← Learn home</RouterLink>
    <header class="page-intro"><h1>Learn</h1><p>Meet new words and get comfortable using them.</p></header>
    <template v-if="learnHome">
      <NAlert v-if="homeLoadError" type="error" role="alert">
        Your local learning data could not be loaded. <NButton text @click="reloadHome">Try again</NButton>
      </NAlert>
      <p v-else-if="!home" class="library-muted" aria-live="polite">Loading your learning data…</p>
      <template v-else>
        <NCard class="learn-start-card">
          <div class="learn-card-content">
            <p class="learn-overline">{{ home.completedToday }} of {{ home.quota }} new words completed today</p>
            <NProgress type="line" :percentage="Math.min(100, Math.round(home.completedToday / home.quota * 100))"
              :show-indicator="false" aria-label="Today's first learning progress" />
            <label for="learn-deck">Word deck</label>
            <NSelect v-model:value="selectedDeckId" :options="deckOptions" clearable
              placeholder="Choose a deck" aria-label="Choose a deck" />
            <div class="learn-quota-row">
              <div><h2>Daily new words</h2><p>One shared limit across your active decks.</p></div>
              <NInputNumber :value="dailyWords" :min="1" :max="100" :step="1" :disabled="busy"
                aria-label="Daily new words" @update:value="saveDailyWords" />
            </div>
          </div>
        </NCard>
        <NCard v-if="home.activeSession" class="learn-session-choice">
          <h2>Continue your session?</h2>
          <p class="library-muted">{{ home.activeSession.firstCompletedEntryIds.length }} first completions ·
            word {{ Math.min(home.activeSession.currentIndex + 1, home.activeSession.entryIds.length) }}
            of {{ home.activeSession.entryIds.length }} · {{ home.activeSession.mode === 'copy' ? 'Copy' : 'Dictation' }}
          </p>
          <div class="learn-actions">
            <NButton type="primary" :disabled="busy" @click="continueSession(home.activeSession)">Continue session</NButton>
            <NButton :disabled="busy" @click="abandonSession(home.activeSession)">End and save session</NButton>
          </div>
        </NCard>
        <NCard v-else-if="home.decks.length" class="learn-session-choice">
          <h2>{{ dailyRemaining ? 'Ready for a few new words?' : 'Today’s new word limit is complete' }}</h2>
          <p class="library-muted">{{ selectedDeckId
            ? eligibleCount + ' new words available · ' + dailyRemaining + ' places remaining today'
            : 'Choose a deck to see today’s available new words.' }}</p>
          <div class="learn-mode-picker">
            <span>Practice mode</span>
            <NRadioGroup :value="mode" name="learn-mode" aria-label="Practice mode"
              @update:value="(value) => { mode = value as LearnMode }">
              <NRadioButton value="copy">Copy</NRadioButton>
              <NRadioButton value="dictation">Dictation</NRadioButton>
            </NRadioGroup>
          </div>
          <NAlert v-if="mode === 'dictation' && !speechAvailable" type="warning">
            Dictation needs an English voice on this device. Choose Copy to continue without speech.
          </NAlert>
          <div class="learn-actions">
            <NButton type="primary" :disabled="!selectedDeckId || !eligibleCount || !dailyRemaining
              || (mode === 'dictation' && !speechAvailable)" @click="beginNewWords(mode)">
              Learn {{ Math.min(eligibleCount, dailyRemaining) }} new
              {{ Math.min(eligibleCount, dailyRemaining) === 1 ? 'word' : 'words' }}
            </NButton>
            <NButton v-if="selectedDeckId && repeatCount" secondary
              :disabled="mode === 'dictation' && !speechAvailable" @click="beginPractice(mode)">
              Practice {{ repeatCount }} learned {{ repeatCount === 1 ? 'word' : 'words' }}
            </NButton>
          </div>
        </NCard>
        <NEmpty v-else description="Create a deck in Library to start learning.">
          <template #extra><RouterLink to="/library" class="library-back">Open Library</RouterLink></template>
        </NEmpty>
        <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
        <NAlert v-if="localMessage" type="info" role="status">{{ localMessage }}</NAlert>
      </template>
    </template>
    <NAlert v-else-if="sessionLoadError" type="error" role="alert">
      This session could not be loaded. <NButton text @click="reloadSession">Try again</NButton>
    </NAlert>
    <p v-else-if="sessionId && !current" class="library-muted" aria-live="polite">Restoring your learning session…</p>
    <NCard v-else-if="result?.session?.status === 'completed'" class="learn-result-card">
      <p class="learn-overline">Session complete</p>
      <h2>Words you worked through</h2>
      <div class="learn-result-grid">
        <div><strong>{{ result.completed }}</strong><span>completed</span></div>
        <div><strong>{{ result.firstCompleted }}</strong><span>first learning</span></div>
        <div><strong>{{ result.firstTryCorrect }}</strong><span>first try correct</span></div>
        <div><strong>{{ result.skipped }}</strong><span>skipped</span></div>
      </div>
      <p>{{ result.attempts }} submitted {{ result.attempts === 1 ? 'answer' : 'answers' }}
        · {{ result.assisted }} assisted {{ result.assisted === 1 ? 'answer' : 'answers' }}</p>
      <div class="learn-actions">
        <NButton type="primary" @click="router.push({ path: '/learn', query: selectedDeckId ? { deckId: selectedDeckId } : {} })">Continue learning</NButton>
        <NButton @click="router.push('/library')">Return to Library</NButton>
      </div>
    </NCard>
    <template v-else-if="current?.session">
      <NAlert v-if="current.invalidReason === 'archived'" type="warning">
        This deck is archived. Pause this session, then restore it in Library to continue.
        <NButton text @click="endSession(current.session)">Pause session</NButton>
        <RouterLink :to="{ path: '/library/' + current.session.deckId }" class="library-back">Open deck</RouterLink>
      </NAlert>
      <NAlert v-else-if="current.invalidReason === 'removed'" type="warning">
        This word was removed while you were away.
        <NButton text @click="learn.advanceInvalid(current.session.sessionId, 'removed').then(reloadSession)">Skip removed word</NButton>
      </NAlert>
      <NAlert v-else-if="current.session.status === 'paused'" type="info">
        Session paused. <NButton text @click="continueSession(current.session)">Resume</NButton>
      </NAlert>
      <NCard v-else-if="current.entry" class="learn-card">
        <div class="learn-session-top">
          <span>{{ current.session.mode === 'copy' ? 'Copy · 跟写' : 'Dictation · 听写' }}</span>
          <span>{{ current.session.currentIndex + 1 }} / {{ current.session.entryIds.length }}</span>
        </div>
        <NProgress type="line" :percentage="progressValue" :show-indicator="false" aria-label="Session progress" />
        <p v-if="current.entry.meaning" class="learn-meaning">{{ current.entry.meaning }}</p>
        <p v-else class="learn-meaning learn-muted">Meaning not added yet</p>
        <p v-if="current.entry.phonetic" class="learn-phonetic">{{ current.entry.phonetic }}</p>
        <h2 v-if="current.session.mode === 'copy'" class="learn-term">{{ current.entry.term }}</h2>
        <p v-if="current.session.mode === 'dictation'" class="library-muted">
          Listen to the word. The English example stays hidden during dictation.
        </p>
        <blockquote v-if="current.session.mode === 'copy' && current.entry.example" class="learn-example">
          {{ current.entry.example }}
        </blockquote>
        <div class="learn-practice-area">
          <NButton v-if="current.session.mode === 'dictation'" :disabled="!speechAvailable || busy"
            @click="playPronunciation">{{ speechSpeaking ? 'Playing…' : 'Play English pronunciation' }}</NButton>
          <p v-if="current.session.mode === 'dictation' && !speechAvailable" class="learn-voice-message">
            {{ speechError || 'No English voice is available. Pause this session or choose Copy.' }}
            <NButton text @click="switchToCopy(current.session)">Switch to Copy</NButton>
          </p>
          <NInput :ref="setInputElement" v-model:value="input" :disabled="busy || current.session.status !== 'active'
            || submittedCorrectly || current.invalidReason !== undefined" :input-props="{
              'aria-label': current.session.mode === 'copy' ? 'Copy the word' : 'Type the dictated word',
              autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'done',
              onCompositionstart: () => { composing = true }, onCompositionend: () => { composing = false },
            }" placeholder="Type your answer"
            @submit.prevent="submittedCorrectly ? completeWord() : submit()"
            @compositionstart="composing = true" @compositionend="composing = false" />
          <div v-if="input" class="learn-spelling" aria-live="polite"
            :aria-label="feedback.map((part) => part.actual + ': ' + part.status).join(', ')">
            <span v-for="(part, index) in feedback" :key="index" :class="'letter-' + part.status"
              aria-hidden="true">{{ part.actual === ' ' ? '·' : part.actual }}</span>
          </div>
          <p class="learn-keyboard-hint">Press Enter to check spelling. IME composition is preserved.</p>
          <NAlert v-if="localMessage" :type="submittedCorrectly ? 'success' : 'info'" role="status">{{ localMessage }}</NAlert>
          <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
          <NAlert v-if="current.entry.meaning.trim() === ''" type="info">
            This word needs a meaning. Spelling practice remains available.
          </NAlert>
        </div>
        <div class="learn-actions learn-session-actions">
          <NButton v-if="!submittedCorrectly" type="primary"
            :disabled="busy || !input.trim() || current.session.status !== 'active'" @click="submit">Check spelling</NButton>
          <NButton v-else type="primary" :disabled="busy" @click="completeWord">Next word</NButton>
          <NButton v-if="current.session.mode === 'dictation' && !submittedCorrectly"
            :disabled="busy || !current.entry" @click="markAssisted">Reveal answer</NButton>
          <NButton v-if="!submittedCorrectly" :disabled="busy || current.session.status !== 'active'" @click="skipWord">Skip word</NButton>
          <NButton v-if="current.session.status === 'active'" :disabled="busy" @click="pauseSession(current.session)">Pause</NButton>
          <NButton :disabled="busy" @click="endSession(current.session)">End session</NButton>
        </div>
        <p v-if="activeDeck" class="learn-deck-name">From {{ activeDeck.name }}</p>
      </NCard>
    </template>
    <NCard v-else-if="sessionLoadError"><NEmpty description="The saved session is unavailable.">
      <template #extra><NButton @click="router.replace('/learn')">Return to Learn</NButton></template>
    </NEmpty></NCard>
    <p class="learn-distinction">Spelling practice records exposure and attempts. It never schedules an FSRS review.</p>
  </section>
</template>
