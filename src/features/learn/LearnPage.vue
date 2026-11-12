<script setup lang="ts">
import DictionaryMeaningView from '../dictionary/DictionaryMeaningView.vue'
import { t, translateError } from '../../i18n/useI18n'
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInputNumber, NProgress, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import type { Entry as EntryRecord } from '../../../shared/domain/library'
import { hasFinalMeaning } from '../../../shared/domain/dictionary'
import type { LearnMode } from '../../../shared/domain/learning'
import { practiceRound } from '../../../shared/domain/learning'
import { defaultSpelling, type SpellingHint } from '../../../shared/domain/spelling'
import SpellingInput from '../spelling/SpellingInput.vue'
import { library } from '../library/api'
import { ApiError, writeDailyNewWords } from '../../api/client'
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
const free = computed(() => route.query.free === '1' || current.value?.session.source === 'free')
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
const localMessage = ref('')
const dailyWords = ref(10)
const activeWord = computed(() => current.value?.session.status === 'active' ? current.value.entry : undefined)
const wordKey = computed(() => activeWord.value && current.value
  ? [current.value.session.sessionId, current.value.session.currentIndex, activeWord.value.id].join('/') : undefined)
const submittedCorrectly = computed(() => !!current.value?.correct)
const isCopy = computed(() => current.value?.session.mode === 'copy')
const reading = computed(() => route.path === '/learn/read' && isCopy.value)
const spelling = computed(() => route.path === '/learn/spell')
const inPractice = computed(() => activeWord.value && (reading.value || spelling.value))
const answerVisible = computed(() => !!current.value?.answerVisible)
const preferences = computed(() => current.value?.session.spelling ?? defaultSpelling)
const round = computed(() => current.value ? practiceRound(current.value.session) : 0)
const { data: freeSession, reload: reloadFree } = useLibraryQuery(() => route.query.free === '1',
  (enabled, signal) => enabled ? learn.freeState(enabled, signal) : Promise.resolve(undefined))
const { data: freeLists } = useLibraryQuery(() => free.value ? selectedDeckId.value : '',
  (id, signal) => id ? library.getLists(id, signal) : Promise.resolve(null))
const freeListOptions = computed(() => freeLists.value?.lists.filter(({ count }) => count)
  .map(({ id, name }) => ({ value: id, label: name })) ?? [])
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
  return { deckId, listId, session, free: free.value ? '1' : undefined }
}

function listLink(deckId: string, listId: string) {
  return { name: 'library-deck', params: { deckId }, query: { listId } }
}

watch(() => home.value?.dailyNewWords, (quota) => { if (quota !== undefined) dailyWords.value = quota })

watch(() => current.value?.session.mode, (value) => { if (value) mode.value = value }, { immediate: true })
watch(wordKey, () => { localMessage.value = '' })

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
    await reloadFree()
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
    if (session.source === 'free') {
      await learn.setStatus(session.sessionId, 'abandoned', session.revision)
      return
    }
    await learn.setStatus(session.sessionId, 'paused', session.revision)
    await router.push({ path: '/learn', query: learnQuery(session.deckId, session.listId) })
    await reloadHome()
  })
}

let pendingAttempt: { key: string; answer: string; partial: boolean; revision: number } | undefined

function submit(answer: string, partial: boolean) {
  const session = current.value?.session
  const entry = activeWord.value
  const key = wordKey.value
  if (!session || !entry || !key || submittedCorrectly.value) return Promise.resolve(undefined)
  localMessage.value = ''
  if (pendingAttempt?.key !== key || pendingAttempt.answer !== answer || pendingAttempt.partial !== partial) {
    pendingAttempt = { key, answer, partial, revision: session.revision }
  }
  const request = pendingAttempt
  return run(async () => {
    try {
      const result = await learn.recordAttempt(session.sessionId, entry.id, answer, request.revision, partial)
      pendingAttempt = undefined
      return result
    } catch (cause) {
      if (cause instanceof ApiError && cause.status > 0 && cause.status < 500 && cause.status !== 408) {
        pendingAttempt = undefined
        if (cause.status === 409) await reloadSession()
      }
      throw cause
    }
  })
}

async function finishWord(outcome: 'completed' | 'skipped') {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || busy.value || (outcome === 'completed') !== submittedCorrectly.value) return
  await run(() => learn.finishCurrent(session.sessionId, entry.id, outcome, session.revision))
}

async function markAssisted(hint: SpellingHint = 'reveal', enabled = true) {
  const session = current.value?.session
  const entry = activeWord.value
  if (!session || !entry || submittedCorrectly.value) return
  const key = wordKey.value
  const saved = await run(() => hint === 'reveal'
    ? learn.setAssisted(session.sessionId, entry.id, session.revision)
    : learn.setHint(session.sessionId, entry.id, hint, enabled, session.revision))
  if (wordKey.value !== key) return
  if (saved && hint === 'reveal') localMessage.value = 'Answer revealed. This answer will be marked as assisted.'
  else if (saved === false && enabled) localMessage.value = hint === 'syllables'
    ? 'No verified syllable guide is available for this word.' : 'This word uses the full keyboard.'
  else if (saved) localMessage.value = ''
}

function switchToCopy(session: LearnSessionRecord) {
  void run(() => learn.setMode(session.sessionId, 'copy', session.revision))
}

function startFree() {
  if (!selectedDeckId.value) return
  void run(async () => {
    const session = await learn.startFree(selectedDeckId.value, mode.value, selectedListId.value)
    await router.push(learnSessionRoute(session))
  })
}

function endFreeFromHome(session: LearnSessionRecord) {
  void run(async () => {
    await learn.setStatus(session.sessionId, 'abandoned', session.revision)
    await router.push({ path: '/learn', query: learnQuery(session.deckId, session.listId, session.sessionId) })
  })
}

function chooseFreeScope(deckId: string | null, listId?: string) {
  void router.replace({ path: '/learn', query: learnQuery(deckId || undefined, listId) })
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
      :class="{ 'spell-session-back icon-control': inPractice }"
      :to="free ? { path: '/learn', query: learnQuery(selectedDeckId || undefined, selectedListId) } : inPractice ? '/study' : '/learn'"
      :aria-label="free ? t('Free spelling') : inPractice ? t('Lexyn home') : undefined">
      <AppIcon v-if="inPractice" name="chevronLeft" /><template v-else>← {{ t(free ? 'Free spelling' : 'Learn') }}</template>
    </RouterLink>
    <header class="page-intro"><h1>{{ t(free ? 'Free spelling' : 'Learn') }}</h1></header>
    <template v-if="learnHome && free">
      <NCard v-if="freeSession" class="learn-session-choice">
        <h2>{{ t('Continue your session?') }}</h2>
        <div class="learn-actions">
          <NButton type="primary" :disabled="busy" @click="continueSession(freeSession)">{{ t('Continue session') }}</NButton>
          <NButton :disabled="busy" @click="endFreeFromHome(freeSession)">{{ t('End session') }}</NButton>
        </div>
      </NCard>
      <NCard v-else class="learn-start-card">
        <div class="learn-card-content">
          <NSelect :value="selectedDeckId || null" :options="deckOptions" :placeholder="t('Choose a deck')"
            :aria-label="t('Choose a deck')" @update:value="(value) => chooseFreeScope(value)" />
          <NSelect v-if="selectedDeckId" :value="selectedListId ?? null" :options="freeListOptions" clearable
            :placeholder="t('Whole wordbook')" :aria-label="t('Study list')"
            @update:value="(value) => chooseFreeScope(selectedDeckId, value ?? undefined)" />
          <div class="learn-mode-picker">
            <span>{{ t('Practice mode') }}</span>
            <NRadioGroup v-model:value="mode" name="free-practice-mode" :aria-label="t('Practice mode')">
              <NRadioButton value="copy">{{ t('Copy') }}</NRadioButton>
              <NRadioButton value="dictation">{{ t('Dictation') }}</NRadioButton>
            </NRadioGroup>
          </div>
          <p class="library-muted">{{ t('Practice up to 100 words without using your daily new word quota.') }}</p>
          <NButton type="primary" :disabled="busy || !selectedDeckId || !home" @click="startFree">{{ t('Start free spelling') }}</NButton>
        </div>
      </NCard>
      <NAlert v-if="error || homeLoadError" type="error" role="alert">{{ translateError(error || homeLoadError) }}</NAlert>
    </template>
    <template v-else-if="learnHome">
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
    <NCard v-else-if="result && (current?.session.status === 'completed' || (free && current?.session.status === 'abandoned'))" class="learn-result-card">
      <p class="learn-overline">{{ t(current.session.status === 'abandoned' ? 'Session ended' : 'Session complete') }}</p>
      <h2>{{ t('Words you worked through') }}</h2>
      <div class="learn-result-grid">
        <div><strong>{{ result.completed }}</strong><span>{{ t('completed') }}</span></div>
        <div><strong>{{ result.firstCompleted }}</strong><span>{{ t('first learning') }}</span></div>
        <div><strong>{{ result.firstTryCorrect }}</strong><span>{{ t('unassisted first try correct') }}</span></div>
        <div><strong>{{ result.skipped }}</strong><span>{{ t('skipped') }}</span></div>
      </div>
      <p>{{ t(result.attempts === 1 ? '{count} submitted answer' : '{count} submitted answers', { count: result.attempts }) }}
        · {{ t(result.assisted === 1 ? '{count} assisted answer' : '{count} assisted answers', { count: result.assisted }) }}</p>
      <p v-if="result.corrected || result.retried || result.unfinished" class="library-muted">
        {{ t('{corrected} corrected · {retried} completed in a retry · {unfinished} unfinished', {
          corrected: result.corrected, retried: result.retried, unfinished: result.unfinished,
        }) }}
      </p>
      <p v-if="result.difficult.length" class="library-muted">{{ t('Words to practice again') }} · {{ result.difficult.join(', ') }}</p>
      <div class="learn-actions">
        <RouterLink v-if="free" class="book-continue" :to="{ path: '/learn', query: learnQuery(current.session.deckId, current.session.listId) }">
          {{ t('Free spelling') }}
        </RouterLink>
        <template v-else-if="current.session.listId">
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
        <NButton v-if="free" text @click="endSession(current.session)">{{ t('End session') }}</NButton>
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
      <SpellingInput v-else-if="activeWord && spelling && current.keyboard" :key="wordKey" :mode="current.session.mode"
        :term="answerVisible ? activeWord.term : ''" :keys="current.keyboard" :syllables="current.syllables"
        :strict="preferences.strict" :speak-letters="preferences.speakLetters" :accent="pronunciationAccent"
        :initial-input="preferences.strict ? undefined : current.session.currentLastSubmitted" :correct="submittedCorrectly" :busy="busy"
        :progress="progressValue" :submit="submit" :finish="() => finishWord('completed')">
        <template #hint>
          <RouterLink v-if="isCopy" class="icon-control" :to="{ path: '/learn/read', query: route.query }" :aria-label="t('Learn the word')">
            <AppIcon name="bulb" />
          </RouterLink>
          <button v-else-if="!answerVisible" type="button" class="icon-control" :aria-label="t('Reveal answer')" :disabled="busy"
            @click="markAssisted()"><AppIcon name="bulb" /></button>
        </template>
        <template #menu>
          <SessionMenu>
            <NButton v-if="!submittedCorrectly" text :disabled="busy" @click="markAssisted('keyboard', current.keyboard.layout !== 'simplified')">
              {{ t(current.keyboard.layout === 'simplified' ? 'Use full keyboard' : 'Use simplified keyboard') }}
            </NButton>
            <NButton v-if="!submittedCorrectly" text :disabled="busy" @click="markAssisted('syllables', !current.syllables)">
              {{ t(current.syllables ? 'Hide syllable guide' : 'Show syllable guide') }}
            </NButton>
            <NButton v-if="!submittedCorrectly" text :disabled="busy" @click="finishWord('skipped')">{{ t('Skip word') }}</NButton>
            <NButton text :disabled="busy" @click="pauseSession(current.session)">{{ t('Pause') }}</NButton>
            <NButton text :disabled="busy" @click="endSession(current.session)">{{ t('End session') }}</NButton>
            <RouterLink to="/library">{{ t('Library') }}</RouterLink>
            <RouterLink :to="settingsRoute(route.fullPath)">{{ t('Settings') }}</RouterLink>
          </SessionMenu>
        </template>
        <template #before-word>
          <p v-if="!isCopy && answerVisible" class="learn-overline">{{ t('Answer revealed') }}</p>
          <p v-else-if="round" class="learn-overline">{{ t('Retry {count}', { count: round }) }}</p>
        </template>
        <template #clues>
          <div class="spell-pronunciation">
            <PronunciationButton :entry-id="activeWord.id" :revision="activeWord.revision" :scope="wordKey + '/' + current.session.mode"
              :disabled="busy" :preload="!isCopy" :label="isCopy ? 'Play pronunciation' : 'Play English pronunciation'"
              :show-phonetic="!learningPreferences.hidePhonetics"
              :phonetics="answerVisible ? activeWord.phonetics : undefined"
              :legacy-phonetic="answerVisible ? activeWord.phonetic : undefined" :accent="pronunciationAccent" />
          </div>
          <DictionaryMeaningView v-if="answerVisible && hasFinalMeaning(activeWord.dictionaryMeaning)" :meaning="activeWord.dictionaryMeaning!" />
          <p v-else-if="activeWord.meaning" class="learn-meaning">{{ activeWord.meaning }}</p>
          <p v-else-if="answerVisible" class="learn-meaning learn-muted">{{ t('Meaning not added yet') }}</p>
          <p v-if="!isCopy" class="library-muted">{{ t('Listen to the word. The English spelling stays hidden during dictation.') }}</p>
        </template>
        <template #messages>
          <div v-if="!isCopy || localMessage || error || (answerVisible && !activeWord.meaning.trim())" class="learn-practice-area">
            <NButton v-if="!isCopy" text :disabled="busy" @click="switchToCopy(current.session)">{{ t('Switch to Copy') }}</NButton>
            <NAlert v-if="localMessage" type="info" role="status">{{ t(localMessage) }}</NAlert>
            <NAlert v-if="error" type="error" role="alert">
              {{ translateError(error) }} <NButton text @click="reloadHome(); reloadSession()">{{ t('Reload Learn') }}</NButton>
            </NAlert>
            <NAlert v-if="answerVisible && !activeWord.meaning.trim()" type="info">
              {{ t('This word needs a meaning. Spelling practice remains available.') }}
            </NAlert>
          </div>
        </template>
      </SpellingInput>
      <p v-else-if="activeWord" class="library-muted" aria-live="polite">{{ t('Restoring your learning session…') }}</p>
    </template>
    <p v-if="!inPractice" class="learn-distinction">{{ t('Spelling practice records exposure and attempts. It never schedules an FSRS review.') }}</p>
  </section>
</template>
