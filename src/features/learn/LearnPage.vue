<script setup lang="ts">
import DictionaryMeaningView from '../dictionary/DictionaryMeaningView.vue'
import { t, translateError } from '../../i18n/useI18n'
import { computed, nextTick, onScopeDispose, ref, watch, type InputHTMLAttributes } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NInputNumber, NProgress, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import type { Entry as EntryRecord } from '../../../shared/domain/library'
import { hasFinalMeaning } from '../../../shared/domain/dictionary'
import type { LearnMode } from '../../../shared/domain/learning'
import { compareSpelling, isSpellingCorrect, normalizeSpelling } from '../../../shared/domain/learning'
import { writeDailyNewWords } from '../../api/client'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { useLibraryAction } from '../library/library-ui'
import { pronunciationAccent } from '../../ui/pronunciationAccent'
import { learn, learnSessionRoute, type LearnSessionRecord } from './api'
import PronunciationButton from '../speech/PronunciationButton.vue'
import { settingsRoute } from '../settings/navigation'
import AppIcon from '../../components/AppIcon.vue'
import SessionMenu from '../../components/SessionMenu.vue'
import { learningPreferences, setDefaultLearnMode } from '../../ui/learningPreferences'

const route = useRoute()
const router = useRouter()
const selectedDeckId = ref(typeof route.query.deckId === 'string' ? route.query.deckId : '')
const selectedListId = computed(() => typeof route.query.listId === 'string' ? route.query.listId : undefined)
watch(() => route.query.deckId, (deckId) => { selectedDeckId.value = typeof deckId === 'string' ? deckId : '' })
const mode = ref<LearnMode>(learningPreferences.value.defaultMode)
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : undefined)
const { data: home, error: homeLoadError, reload: reloadHome } =
  useLibraryQuery(() => [selectedDeckId.value || undefined, selectedListId.value] as [string | undefined, string | undefined],
    learn.getDailyState, (args) => args.join('/'))
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
const reading = computed(() => route.path === '/learn/read' && isCopy.value)
const spelling = computed(() => route.path === '/learn/spell')
const guidedCopy = computed(() => spelling.value && isCopy.value)
const inPractice = computed(() => activeWord.value && (reading.value || spelling.value))
const typoIndex = ref<number>()
const advancing = ref(false)
let typoTimer: number | undefined
const keyboardVisible = ref(true)
const keyboardRows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const extraKeys = computed(() => isCopy.value ? [...new Set([...expected.value.toLowerCase()]
  .filter((character) => !/[a-z\s]/.test(character)))] : [])
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
const typedLetters = computed(() => [...input.value.normalize('NFC')])
const expectedLetters = computed(() => [...expected.value.normalize('NFC')])

function incorrectLetter(index: number) {
  return index === typoIndex.value || (answerVisible.value
    && typedLetters.value[index]?.toLowerCase() !== expectedLetters.value[index]?.toLowerCase())
}

function clearTypoTimer() {
  window.clearTimeout(typoTimer)
  typoTimer = undefined
}

onScopeDispose(clearTypoTimer)
watch([wordKey, guidedCopy], () => {
  clearTypoTimer()
  if (typoIndex.value !== undefined) input.value = ''
  typoIndex.value = undefined
})

watch([input, composing], ([value, isComposing]) => {
  if (!guidedCopy.value || !value || isComposing || busy.value || typoIndex.value !== undefined || submittedCorrectly.value) return
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry) return

  if (isSpellingCorrect(expected.value, value)) {
    void submit()
    return
  }
  const mismatch = typedLetters.value.findIndex((letter, index) => letter.toLowerCase() !== expectedLetters.value[index]?.toLowerCase())
  if (mismatch < 0) return

  // Keep the incorrect key visible until the entire attempt can animate away.
  typoIndex.value = mismatch
  if (value.trim()) {
    void run(() => learn.recordAttempt(session.sessionId, entry.id, value, session.revision))
  }
  typoTimer = window.setTimeout(() => {
    input.value = ''
    typoIndex.value = undefined
    typoTimer = undefined
    void nextTick(() => inputElement.value?.focus())
  }, 180)
}, { flush: 'post' })
const promptLetters = computed(() => {
  // Copy mode may show the target word; dictation never renders the target
  // until the user explicitly reveals it.
  const visible = answerVisible.value ? expectedLetters.value : typedLetters.value
  return visible.length <= 32 ? visible : []
})
const promptStates = computed(() => promptLetters.value.map((letter, index) => ({
  letter,
  state: index >= typedLetters.value.length
    ? (index === typedLetters.value.length ? 'current' : 'pending')
    : (incorrectLetter(index) ? 'incorrect' : 'typed'),
})))
const promptSegments = computed(() => {
  const count = answerVisible.value ? expectedLetters.value.length : typedLetters.value.length + 1
  return Array.from({ length: Math.min(count, 32) }, (_, index) => index)
})
const spellingInputProps = computed<InputHTMLAttributes>(() => ({
  'aria-label': isCopy.value ? t('Copy the word') : t('Type the dictated word'),
  autocomplete: 'off',
  autocapitalize: 'none',
  spellcheck: false,
  enterkeyhint: 'done',
  inputmode: keyboardVisible.value ? 'none' : 'text',
  onCompositionstart: () => { composing.value = true },
  onCompositionend: () => { composing.value = false },
  onBlur: () => { composing.value = false },
}))
const progressValue = computed(() => current.value
  ? Math.round(current.value.session.currentIndex / Math.max(current.value.session.entryIds.length, 1) * 100) : 0)
const eligibleCount = computed(() => home.value?.candidates.length ?? 0)
const repeatCount = computed(() => home.value?.practiceCandidates.length ?? 0)
const dailyRemaining = computed(() => Math.max(0, (home.value?.quota ?? 10) - (home.value?.completedToday ?? 0)))
const newWordCount = computed(() => Math.min(eligibleCount.value, dailyRemaining.value))
const deckOptions = computed(() => (home.value?.decks ?? []).map((deck) => ({ label: deck.name, value: deck.id })))
const learnHome = computed(() => !sessionId.value || current.value === null)

watch([() => route.path, current], ([path, snapshot]) => {
  if (snapshot?.session.status === 'active'
    && (path === '/learn' || (path === '/learn/read' && snapshot.session.mode === 'dictation'))) {
    void router.replace(learnSessionRoute(snapshot.session))
  }
})
function learnQuery(deckId?: string, listId?: string, session?: string) {
  return { deckId, listId, session }
}

function listLink(deckId: string, listId: string) {
  return { name: 'library-deck', params: { deckId }, query: { listId } }
}

watch(() => home.value?.dailyNewWords, (quota) => { if (quota !== undefined) dailyWords.value = quota })

watch(() => current.value?.session.mode, (value) => { if (value) mode.value = value }, { immediate: true })
watch([wordKey, lastSubmitted], ([key, answer], [previousKey]) => {
  if (key !== previousKey || submittedCorrectly.value) {
    input.value = isCopy.value && !submittedCorrectly.value ? '' : answer ?? ''
  }
  if (key !== previousKey) {
    composing.value = false
    localMessage.value = ''
  }
})

watch([wordKey, submittedCorrectly, busy, spelling, advancing], async ([key, correct, pending, typing, changingWord]) => {
  if (!key || pending || !typing || changingWord) return
  await nextTick()
  if (key !== wordKey.value || busy.value || advancing.value || !spelling.value) return
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
  if (event.repeat || busy.value || advancing.value) return
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
    const session = await learn.startSession(deckId, sessionMode, candidates.map(({ id }) => id), newWords, selectedListId.value)
    await router.push(learnSessionRoute(session))
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
  const stage = spelling.value ? 'spell' : reading.value ? 'read' : undefined
  void run(async () => {
    const resumed = await learn.continueSession(session.sessionId, session.revision)
    if (resumed) {
      await router.push(learnSessionRoute(resumed, stage))
    }
  })
}

function abandonSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'abandoned', session.revision)
    await router.replace({ path: '/learn', query: learnQuery(selectedDeckId.value || undefined, selectedListId.value) })
    localMessage.value = 'Your completed practice stays in your learning history.'
    await reloadHome()
  })
}

function pauseSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'paused', session.revision)
    await reloadSession()
  })
}

function endSession(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'paused', session.revision)
    await router.push({ path: '/learn', query: learnQuery(session.deckId, session.listId) })
    await reloadHome()
  })
}

async function submit() {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || submittedCorrectly.value || busy.value || advancing.value || composing.value || typoIndex.value !== undefined) return
  const answer = input.value
  if (!answer.trim()) { localMessage.value = 'Type your answer before submitting.'; return }
  localMessage.value = ''
  advancing.value = true
  try {
    const attempt = await run(() => learn.recordAttempt(session.sessionId, entry.id, answer, session.revision))
    if (!attempt || wordKey.value !== session.sessionId + '/' + entry.id) return
    if (attempt.correct) {
      if (spelling.value) {
        await finishWord('completed')
      }
      return
    }
    localMessage.value = 'Not quite. Check the marked letters and try again.'
    const failedWordKey = wordKey.value
    window.setTimeout(() => {
      // Let the learner see the error briefly, then reset only if they have
      // not already started another attempt or moved to a different word.
      if (wordKey.value !== failedWordKey || submittedCorrectly.value || input.value !== answer) return
      input.value = ''
      localMessage.value = ''
      void nextTick(() => inputElement.value?.focus())
    }, 650)
  } finally { advancing.value = false }
}

async function finishWord(outcome: 'completed' | 'skipped') {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || busy.value || (outcome === 'completed') !== submittedCorrectly.value) return
  await run(() => learn.finishCurrent(session.sessionId, entry.id, outcome, session.revision))
}

function enterKey(character: string) {
  if (busy.value || advancing.value || submittedCorrectly.value || composing.value || typoIndex.value !== undefined) return
  input.value += character
  inputElement.value?.focus()
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
    if (!submittedCorrectly.value) input.value = ''
  })
}

async function saveDailyWords(value: number | null) {
  if (value === null || busy.value) return
  const saved = await run(async () => { await writeDailyNewWords(value); return value })
  if (saved) { dailyWords.value = saved; await reloadHome() }
}

</script>

<template>
  <section class="page learn-page" :class="{ 'spell-practice': inPractice, 'spell-reading': inPractice && reading, 'spell-guided': inPractice && spelling }">
    <RouterLink v-if="sessionId && current?.session.listId && current.session.status !== 'completed'"
      class="library-back" :class="{ 'spell-session-back icon-control': inPractice }"
      :aria-label="t('Back to study list')" :to="listLink(current.session.deckId, current.session.listId)">
      <AppIcon v-if="inPractice" name="chevronLeft" /><template v-else>← {{ t('Back to study list') }}</template>
    </RouterLink>
    <RouterLink v-else-if="sessionId && !current?.session.listId" class="library-back"
      :class="{ 'spell-session-back icon-control': inPractice }" :to="inPractice ? '/study' : '/learn'"
      :aria-label="inPractice ? t('Lexyn home') : undefined">
      <AppIcon v-if="inPractice" name="chevronLeft" /><template v-else>{{ t('← Learn home') }}</template>
    </RouterLink>
    <header class="page-intro"><h1>{{ t('Learn') }}</h1></header>
    <template v-if="learnHome">
      <NAlert v-if="homeLoadError" type="error" role="alert">
        {{ t('Your learning data could not be loaded from the server.') }} <NButton text @click="reloadHome">{{ t('Try again') }}</NButton>
      </NAlert>
      <p v-else-if="!home" class="library-muted" aria-live="polite">{{ t('Loading your learning data…') }}</p>
      <template v-else>
        <NCard class="learn-start-card">
          <div class="learn-card-content">
            <p class="learn-overline">{{ home.quota ? t('{count} of {quota} new words completed today', { count: home.completedToday, quota: home.quota }) : t('No new words scheduled today') }}</p>
            <NProgress v-if="home.quota" type="line" :percentage="Math.min(100, Math.round(home.completedToday / home.quota * 100))"
              :show-indicator="false" :aria-label="t('Today\'s first learning progress')" />
            <div v-if="home.list" class="learn-list-context">
              <RouterLink :to="listLink(home.list.deckId, home.list.id)" class="library-back">{{ home.list.name }}</RouterLink>
              <p>{{ t('{learned} of {total} words learned', { learned: home.list.learned, total: home.list.count }) }}</p>
            </div>
            <template v-else>
              <label for="learn-deck">{{ t('Word deck') }}</label>
              <NSelect v-model:value="selectedDeckId" :options="deckOptions" clearable
                :placeholder="t('Choose a deck')" :aria-label="t('Choose a deck')" />
            </template>
            <div class="learn-quota-row">
              <div><h2>{{ t('Daily new words') }}</h2><p>{{ t('One shared limit across your active decks.') }}</p></div>
              <NInputNumber :value="dailyWords" :min="1" :max="100" :step="1" :disabled="busy"
                :aria-label="t('Daily new words')" @update:value="saveDailyWords" />
            </div>
          </div>
        </NCard>
        <NCard v-if="home.activeSession" class="learn-session-choice">
          <h2>{{ t('Continue your session?') }}</h2>
          <p v-if="home.list && home.activeSession.listId !== home.list.id" class="library-muted">
            {{ t('An unfinished session is open outside this list.') }}
          </p>
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
              @update:value="(value) => { mode = value as LearnMode; setDefaultLearnMode(mode) }">
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
        <template v-if="current.session.listId">
          <RouterLink class="book-continue" :to="listLink(current.session.deckId, current.session.listId)">{{ t('Return to study list') }}</RouterLink>
          <RouterLink v-if="home?.nextList && home.list?.count && home.list.learned === home.list.count" class="library-back"
            :to="listLink(current.session.deckId, home.nextList.id)">{{ t('Next list') }} · {{ home.nextList.name }}</RouterLink>
        </template>
        <template v-else>
          <NButton type="primary" @click="router.push({ path: '/learn', query: learnQuery(current.session.deckId) })">{{ t('Continue learning') }}</NButton>
          <NButton @click="router.push('/library')">{{ t('Return to Library') }}</NButton>
        </template>
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
      <article v-else-if="activeWord && reading" class="spell-reading-word">
        <div class="spell-reading-tools">
          <NProgress class="spell-reading-progress" type="circle" :percentage="progressValue" :show-indicator="false"
            :aria-label="t('Session progress')" />
          <SessionMenu>
            <NButton text :disabled="busy" @click="pauseSession(current.session)">{{ t('Pause') }}</NButton>
            <NButton text :disabled="busy" @click="endSession(current.session)">{{ t('End session') }}</NButton>
            <RouterLink :to="settingsRoute(route.fullPath)">{{ t('Settings') }}</RouterLink>
          </SessionMenu>
        </div>
        <h2 class="learn-term">{{ activeWord.term }}</h2>
        <div class="spell-pronunciation">
          <PronunciationButton :entry-id="activeWord.id" :revision="activeWord.revision" label="Play pronunciation"
            :phonetics="activeWord.phonetics" :legacy-phonetic="activeWord.phonetic" :accent="pronunciationAccent" />
        </div>
        <DictionaryMeaningView v-if="hasFinalMeaning(activeWord.dictionaryMeaning)" :meaning="activeWord.dictionaryMeaning!" />
        <p v-else class="learn-meaning">{{ activeWord.meaning || t('Meaning not added yet') }}</p>
        <div v-if="activeWord.example" class="spell-example">
          <span>{{ t('Example') }}</span>
          <p class="spell-glass">{{ activeWord.example }}</p>
        </div>
        <RouterLink class="spell-glass spell-start spell-reading-next" :to="{ path: '/learn/spell', query: route.query }">
          {{ t('Start spelling') }} <span aria-hidden="true">→</span>
        </RouterLink>
      </article>
      <article v-else-if="activeWord && spelling" class="spell-stage" @keydown="onKeydown">
        <div class="spell-guided-toolbar">
          <div class="spell-stage-tools" role="group" :aria-label="t('Spelling tools')">
            <RouterLink v-if="isCopy" class="icon-control" :to="{ path: '/learn/read', query: route.query }" :aria-label="t('Learn the word')">
              <AppIcon name="bulb" />
            </RouterLink>
            <button v-else-if="!answerVisible" type="button" class="icon-control" :aria-label="t('Reveal answer')" :disabled="busy" @click="markAssisted">
              <AppIcon name="bulb" />
            </button>
            <button type="button" class="icon-control" :aria-label="t('Check spelling')"
              :disabled="busy || typoIndex !== undefined || !input.trim() || submittedCorrectly" @click="submit"><AppIcon name="checkCircle" /></button>
            <button type="button" class="icon-control" :aria-label="t('On-screen keyboard')"
              :aria-pressed="keyboardVisible" @click="keyboardVisible = !keyboardVisible"><AppIcon name="keyboard" /></button>
          </div>
          <NProgress class="spell-guided-progress" type="circle" :percentage="progressValue" :show-indicator="false" :aria-label="t('Session progress')" />
          <SessionMenu>
            <NButton v-if="!submittedCorrectly" text :disabled="busy" @click="finishWord('skipped')">{{ t('Skip word') }}</NButton>
            <NButton text :disabled="busy" @click="pauseSession(current.session)">{{ t('Pause') }}</NButton>
            <NButton text :disabled="busy" @click="endSession(current.session)">{{ t('End session') }}</NButton>
            <RouterLink to="/library">{{ t('Library') }}</RouterLink>
            <RouterLink :to="settingsRoute(route.fullPath)">{{ t('Settings') }}</RouterLink>
          </SessionMenu>
        </div>
        <div class="spell-clue">
          <p v-if="!isCopy && answerVisible" class="learn-overline">{{ t('Answer revealed') }}</p>
          <div class="spell-entry">
            <h2 v-if="answerVisible" class="visually-hidden">{{ activeWord.term }}</h2>
            <div class="spell-entry-field">
              <template v-if="promptLetters.length">
                <div class="spell-word-display">
                  <div class="spell-prompt" aria-hidden="true">
                    <span v-for="({ letter, state }, index) in promptStates" :key="index"
                      :class="'spell-prompt-' + state">
                      {{ letter === ' ' ? '\u00a0' : letter }}
                    </span>
                  </div>
                  <div class="spell-prompt-progress" aria-hidden="true">
                    <span v-for="index in promptSegments" :key="index"
                      :class="index < typedLetters.length
                        ? (incorrectLetter(index) ? 'segment-incorrect' : 'segment-typed')
                        : (index === typedLetters.length ? 'segment-current' : 'segment-pending')" />
                  </div>
                </div>
              </template>
              <p v-else class="spell-long-answer" aria-hidden="true">{{ answerVisible ? expected : input || t('Type your answer') }}</p>
              <NInput ref="inputElement" v-model:value="input" class="spell-entry-input"
                :readonly="busy || typoIndex !== undefined || advancing" :disabled="submittedCorrectly && !advancing"
                :input-props="spellingInputProps" />
            </div>
          </div>
          <div class="spell-pronunciation">
            <PronunciationButton :entry-id="activeWord.id" :revision="activeWord.revision" :scope="wordKey + '/' + current.session.mode"
              :disabled="busy" :preload="!isCopy" :label="isCopy ? 'Play pronunciation' : 'Play English pronunciation'"
              :show-phonetic="!learningPreferences.hidePhonetics"
              :phonetics="answerVisible ? activeWord.phonetics : undefined"
              :legacy-phonetic="answerVisible ? activeWord.phonetic : undefined" :accent="pronunciationAccent" />
          </div>
          <DictionaryMeaningView v-if="answerVisible && hasFinalMeaning(activeWord.dictionaryMeaning)" :meaning="activeWord.dictionaryMeaning!" />
          <p v-else-if="meaning" class="learn-meaning">{{ meaning }}</p>
          <p v-else-if="!activeWord.meaning" class="learn-meaning learn-muted">{{ t('Meaning not added yet') }}</p>
          <p v-if="current.session.mode === 'dictation'" class="library-muted">
            {{ t('Listen to the word. The English spelling stays hidden during dictation.') }}
          </p>
        </div>
        <div v-if="!isCopy || localMessage || error || !activeWord.meaning.trim()" class="learn-practice-area">
          <NButton v-if="!isCopy" text :disabled="busy" @click="switchToCopy(current.session)">{{ t('Switch to Copy') }}</NButton>
          <div v-if="feedback.length && localMessage" class="learn-spelling" aria-live="polite"
            :aria-label="feedback.map((part) => part.actual + ': ' + t(part.status)).join(', ')">
            <span v-for="(part, index) in feedback" :key="index" :class="'letter-' + part.status"
              aria-hidden="true">{{ part.actual === ' ' ? '·' : part.actual }}</span>
          </div>
          <NAlert v-if="localMessage" type="info" role="status">{{ t(localMessage) }}</NAlert>
          <NAlert v-if="error" type="error" role="alert">
            {{ translateError(error) }} <NButton text @click="reloadHome(); reloadSession()">{{ t('Reload Learn') }}</NButton>
          </NAlert>
          <NAlert v-if="activeWord.meaning.trim() === ''" type="info">
            {{ t('This word needs a meaning. Spelling practice remains available.') }}
          </NAlert>
        </div>
        <div v-if="submittedCorrectly && !advancing" class="learn-actions learn-session-actions">
          <NButton ref="nextButton" type="primary" :disabled="busy" @click="finishWord('completed')">{{ t('Next word') }}</NButton>
        </div>
        <div class="spell-keyboard-area">
          <div class="spell-answer-tiles">
            <span class="visually-hidden" role="status">{{ typoIndex !== undefined ? t('Incorrect letter. Try the word again.') : '' }}</span>
            <Transition name="spell-tiles">
              <div v-if="typedLetters.length" class="spell-answer-row" role="group" :aria-label="t('Your spelling so far')">
                <span v-for="(letter, index) in typedLetters" :key="index" class="spell-answer-tile"
                  :class="{ 'spell-answer-tile-incorrect': incorrectLetter(index) }">
                  {{ letter === ' ' ? '·' : letter }}
                </span>
              </div>
            </Transition>
          </div>
          <div v-if="keyboardVisible" class="spell-keyboard" role="group" :aria-label="t('On-screen keyboard')">
            <div v-for="row in keyboardRows" :key="row">
              <button v-for="letter in row" :key="letter" type="button" :disabled="busy || submittedCorrectly || typoIndex !== undefined"
                @mousedown.prevent @click="enterKey(letter)">{{ letter }}</button>
            </div>
            <div v-if="extraKeys.length || !isCopy || /\s/.test(expected)" class="spell-keyboard-extra">
              <button v-for="character in extraKeys" :key="character" type="button" :disabled="busy || submittedCorrectly || typoIndex !== undefined"
                @mousedown.prevent @click="enterKey(character)">{{ character }}</button>
              <button v-if="!isCopy || /\s/.test(expected)" type="button" :disabled="busy || submittedCorrectly || typoIndex !== undefined"
                @mousedown.prevent @click="enterKey(' ')">{{ t('Space') }}</button>
            </div>
          </div>
        </div>
      </article>
      <p v-else-if="activeWord" class="library-muted" aria-live="polite">{{ t('Restoring your learning session…') }}</p>
    </template>
    <p v-if="!inPractice" class="learn-distinction">{{ t('Spelling practice records exposure and attempts. It never schedules an FSRS review.') }}</p>
  </section>
</template>
