<script setup lang="ts">
import SpellingSettings from './SpellingSettings.vue'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NInput, NInputNumber, NRadioButton, NRadioGroup, NSwitch } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import LanguagePicker from '../../i18n/LanguagePicker.vue'
import { t, translateError, useI18n } from '../../i18n/useI18n'
import { connection, signOut, study } from '../../api/client'
import { allStudyDays, forecastStudyPlan } from '../../../shared/domain/study-plan'
import { learn } from '../learn/api'
import { library } from '../library/api'
import { currentBookId } from '../library/currentBook'
import { useLibraryAction } from '../library/library-ui'
import { useLibraryQuery } from '../library/useLibraryQuery'
import SpeechSettings from '../speech/SpeechSettings.vue'
import { useAppearance } from '../../ui/appearance'
import { pronunciationAccent, setPronunciationAccent } from '../../ui/pronunciationAccent'
import BackupSettings from './BackupSettings.vue'
import DictionarySettings from './DictionarySettings.vue'
import { closeSettings, settingsOrigin, settingsRoute } from './navigation'
import { learningPreferences, setDefaultLearnMode, setHidePhonetics } from '../../ui/learningPreferences'

const route = useRoute()
const router = useRouter()
const { languageTag } = useI18n()
const sections = {
  plan: 'Learning plan', preferences: 'Study preferences', speech: 'Reading settings',
  backup: 'Data & Backup', dictionary: 'Dictionary', account: 'Owner account',
} as const
const section = computed(() => {
  const key = route.query.section
  return typeof key === 'string' && Object.hasOwn(sections, key) ? key as keyof typeof sections : undefined
})
const { appearance, busy, error, setAppearance } = useAppearance()
const dailyNewWords = ref<number | null>(10)
const studyWeekdays = ref(allStudyDays)
const reviewResetMinutes = ref(0)
const editingResetTime = ref(false)
const { busy: savingPlan, error: planError, run: runPlan } = useLibraryAction()
const timezone = ref('')
const { busy: accountBusy, error: accountError, run: runAccount } = useLibraryAction()
const owner = useLibraryQuery(() => null, (_, signal) => study('settings/owner', [], { signal }))
const books = useLibraryQuery(() => null, (_, signal) => library.listDecks(signal))
const activeBooks = computed(() => books.data.value?.filter(({ deck }) => deck.archivedAt === undefined))
const book = computed(() => activeBooks.value?.find(({ deck }) => deck.id === currentBookId()))
const planBookId = computed(() => !section.value || section.value === 'plan' ? book.value?.deck.id : undefined)
const { data: today } = useLibraryQuery(planBookId, (deckId, signal) =>
  deckId ? learn.getDailyState([deckId, undefined], signal) : Promise.resolve(undefined))
const deckRoute = computed(() => book.value
  ? { name: 'library-deck', params: { deckId: book.value.deck.id } }
  : undefined)
const planQuota = computed(() => {
  const quota = dailyNewWords.value
  return quota !== null && Number.isInteger(quota) && quota >= 1 && quota <= 100 ? quota : undefined
})
function forecast(quota: number, weekdays: number) {
  if (!book.value || !today.value) return undefined
  return forecastStudyPlan(Math.max(0, book.value.count - book.value.learnedCount),
    quota, weekdays, today.value.day, today.value.completedToday)
}
const plan = computed(() => planQuota.value === undefined ? undefined : forecast(planQuota.value, studyWeekdays.value))
const savedPlan = computed(() => owner.data.value && forecast(owner.data.value.dailyNewWords, owner.data.value.studyWeekdays))
const completionDate = computed(() => plan.value && new Intl.DateTimeFormat(languageTag.value, {
  dateStyle: 'long', timeZone: 'UTC',
}).format(new Date(plan.value.completion + 'T00:00:00Z')))
const weekdayLabels = computed(() => {
  const formatter = new Intl.DateTimeFormat(languageTag.value, { weekday: 'short', timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, index) => formatter.format(Date.UTC(2024, 0, 1 + index)))
})
const quotaOptions = computed(() => {
  const quota = planQuota.value
  return quota === undefined ? [] : [Math.max(1, quota - 5), quota, Math.min(100, quota + 5)]
})
const resetTime = computed({
  get: () => [Math.floor(reviewResetMinutes.value / 60), reviewResetMinutes.value % 60]
    .map((value) => String(value).padStart(2, '0')).join(':'),
  set: (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return
    const [hours, minutes] = value.split(':').map(Number)
    reviewResetMinutes.value = hours * 60 + minutes
  },
})
const groups = [
  { label: 'Plan', links: [{ section: 'plan', label: sections.plan }, { path: '/activity', label: 'Study activity' }] },
  { label: 'Data & Backup', links: [{ section: 'backup', label: sections.backup }, { section: 'account', label: sections.account }] },
  { label: 'Study preferences', links: [{ section: 'preferences', label: sections.preferences }, { section: 'speech', label: sections.speech }] },
  { label: 'General', links: [{ section: 'dictionary', label: sections.dictionary }] },
] as const

watch([section, () => !!owner.data.value], ([current, loaded]) => {
  if (current !== 'plan' || !loaded || !owner.data.value) return
  const settings = owner.data.value
  dailyNewWords.value = settings.dailyNewWords
  studyWeekdays.value = settings.studyWeekdays
  reviewResetMinutes.value = settings.reviewResetMinutes
  editingResetTime.value = false
}, { immediate: true })
watch(() => owner.data.value?.timezone, (value) => { if (value) timezone.value = value })

function resetPlan() {
  dailyNewWords.value = 10
  studyWeekdays.value = allStudyDays
  reviewResetMinutes.value = 0
}

function toggleStudyDay(index: number) {
  const next = studyWeekdays.value ^ (1 << index)
  if (next) studyWeekdays.value = next
}

function savePlan() {
  const quota = planQuota.value
  if (quota === undefined || !owner.data.value) return
  void runPlan(async () => {
    await study('settings/plan', [quota, studyWeekdays.value, reviewResetMinutes.value], { write: true })
    closeSettings(router, settingsRoute(settingsOrigin(router)))
  })
}
</script>

<template>
  <section class="page settings-page" :class="{ 'settings-page-detail': !!section }">
    <template v-if="!section">
      <div class="settings-brand-card">
        <div>
          <h1>{{ t('Settings') }}</h1>
          <span>Lexyn</span>
        </div>
        <img src="/favicon.svg" alt="" width="84" height="84">
      </div>
      <div class="settings-panel">
        <RouterLink v-if="book && deckRoute" class="settings-current-book" :to="deckRoute">
          <div class="settings-book-heading">
            <strong>{{ book.deck.name }} <span class="settings-language-tag">EN</span></strong>
            <AppIcon name="chevronRight" />
          </div>
          <div class="settings-book-count">
            <span>{{ book.learnedCount }} / {{ book.count }}</span>
            <span v-if="savedPlan">{{ t('{count} study days left', { count: savedPlan.days }) }}</span>
          </div>
          <progress :aria-label="t('Progress')" :max="Math.max(1, book.count)" :value="book.learnedCount" />
        </RouterLink>
        <NAlert v-if="books.error.value" class="settings-book-error" type="error">
          {{ translateError(books.error.value) }} <NButton text @click="books.reload">{{ t('Retry') }}</NButton>
        </NAlert>
        <RouterLink class="settings-link" to="/library">
          <span>{{ t('My books') }}</span>
          <span class="settings-link-trailing">{{ activeBooks?.length }} <AppIcon name="chevronRight" /></span>
        </RouterLink>
        <RouterLink v-if="deckRoute" class="settings-link" :to="{ ...deckRoute, query: { importWords: '1' } }">
          <span>{{ t('Import words') }}</span><AppIcon name="chevronRight" />
        </RouterLink>
      </div>

      <section v-for="group in groups" :key="group.label" class="settings-group">
        <h2>{{ t(group.label) }}</h2>
        <div class="settings-panel">
          <RouterLink v-for="link in group.links" :key="link.label" class="settings-link"
            :to="'path' in link ? link.path : settingsRoute(settingsOrigin(router), link.section)">
            <span>{{ t(link.label) }}</span>
            <span class="settings-link-trailing">
              <template v-if="'section' in link && link.section === 'plan'">{{ t('Settings') }}</template>
              <template v-if="'section' in link && link.section === 'account'">
                <span v-if="connection === 'connected'" class="settings-online">{{ t('Connected') }}</span>
              </template>
              <AppIcon name="chevronRight" />
            </span>
          </RouterLink>
        </div>
      </section>
    </template>

    <template v-else>
      <h1 class="settings-detail-title">{{ t(sections[section]) }}</h1>

      <form v-if="section === 'plan'" class="settings-plan" @submit.prevent="savePlan">
        <button type="button" class="settings-plan-default" :disabled="savingPlan || !owner.data.value" @click="resetPlan">{{ t('Default') }}</button>
        <p>{{ t('Choose when to learn new words. Your daily limit is shared across active decks.') }}</p>
        <div class="settings-group">
          <h2 id="settings-weekly-plan">{{ t('Weekly plan') }}</h2>
          <div class="settings-panel settings-weekdays" role="group" aria-labelledby="settings-weekly-plan">
            <button v-for="(day, index) in weekdayLabels" :key="day" type="button"
              :aria-pressed="Boolean(studyWeekdays & (1 << index))"
              :disabled="savingPlan || !owner.data.value || studyWeekdays === (1 << index)"
              @click="toggleStudyDay(index)">{{ day }}</button>
          </div>
        </div>
        <div class="settings-group">
          <h2>{{ t('Daily plan') }}</h2>
          <div class="settings-panel settings-plan-picker">
            <div class="settings-plan-pair"><span>{{ t('Daily new words') }}</span><span>{{ t('Study days left') }}</span></div>
            <template v-for="(quota, index) in quotaOptions.length ? quotaOptions : [undefined, undefined, undefined]" :key="index">
              <div v-if="index === 1" class="settings-plan-pair settings-plan-selection">
                <NInputNumber v-model:value="dailyNewWords" :min="1" :max="100" :step="5" :precision="0"
                  :show-button="false" :disabled="savingPlan || !owner.data.value"
                  :input-props="{ 'aria-label': t('Daily new words') }" />
                <output>{{ plan?.days ?? '—' }}</output>
              </div>
              <button v-else class="settings-plan-pair settings-plan-option" type="button"
                :disabled="savingPlan || !owner.data.value || quota === undefined || quota === planQuota"
                :aria-label="t('Set daily new words to {count}', { count: quota ?? 0 })"
                @click="dailyNewWords = quota ?? dailyNewWords">
                <span>{{ quota ?? '—' }}</span><span>{{ quota === undefined ? '—' : forecast(quota, studyWeekdays)?.days ?? '—' }}</span>
              </button>
            </template>
          </div>
        </div>
        <p v-if="completionDate" class="settings-panel settings-plan-date">{{ t('Estimated completion: {date}', { date: completionDate }) }}</p>
        <div class="settings-group">
          <h2>{{ t('Review settings') }}</h2>
          <div class="settings-panel">
            <button type="button" class="settings-link settings-reset-row" :aria-expanded="editingResetTime"
              :disabled="savingPlan || !owner.data.value" @click="editingResetTime = !editingResetTime">
              <span>{{ t('Review reset time') }}<small>{{ t('Review totals reset at {time}', { time: resetTime }) }}</small></span>
              <AppIcon name="chevronRight" />
            </button>
            <label v-if="editingResetTime" class="settings-link settings-time-input">
              <span>{{ t('Review reset time') }}</span><input v-model="resetTime" type="time" :disabled="savingPlan" required>
            </label>
          </div>
        </div>
        <NAlert v-if="owner.error.value" type="error">
          {{ translateError(owner.error.value) }} <NButton text @click="owner.reload">{{ t('Retry') }}</NButton>
        </NAlert>
        <NAlert v-if="planError" type="error">{{ translateError(planError) }}</NAlert>
        <button type="submit" class="spell-start spell-glass settings-plan-done"
          :disabled="savingPlan || planQuota === undefined || !owner.data.value">{{ t('Done') }}</button>
      </form>

      <div v-else-if="section === 'preferences'" class="settings-preferences">
        <section class="settings-group settings-preference-group">
          <h2>{{ t('Learning mode') }}</h2>
          <div class="settings-panel">
            <div class="settings-link">
              <span>{{ t('Default practice mode') }}</span>
              <NRadioGroup name="default-practice-mode" :aria-label="t('Default practice mode')"
                :value="learningPreferences.defaultMode" @update:value="(value) => setDefaultLearnMode(value as 'copy' | 'dictation')">
                <NRadioButton value="copy">{{ t('Copy') }}</NRadioButton>
                <NRadioButton value="dictation">{{ t('Dictation') }}</NRadioButton>
              </NRadioGroup>
            </div>
          </div>
        </section>
        <section class="settings-group settings-preference-group">
          <h2>{{ t('Spell mode') }}</h2>
          <div class="settings-panel">
            <label class="settings-link">
              <span>{{ t('Hide phonetics during spelling') }}</span>
              <NSwitch :value="learningPreferences.hidePhonetics" @update:value="setHidePhonetics" />
            </label>
            <SpellingSettings />
          </div>
        </section>
        <section class="settings-group settings-preference-group">
          <h2>{{ t('General') }}</h2>
          <div class="settings-panel">
            <div class="settings-link"><span>{{ t('Language') }}</span><LanguagePicker /></div>
            <div class="settings-link">
              <span>{{ t('Appearance') }}</span>
              <NRadioGroup name="appearance" :aria-label="t('Appearance')" :value="appearance" :disabled="busy"
                @update:value="setAppearance">
                <NRadioButton value="system">{{ t('System') }}</NRadioButton>
                <NRadioButton value="light">{{ t('Light') }}</NRadioButton>
                <NRadioButton value="dark">{{ t('Dark') }}</NRadioButton>
              </NRadioGroup>
            </div>
          </div>
        </section>
        <NAlert v-if="error" type="error">{{ translateError(error) }}</NAlert>
      </div>

      <template v-else-if="section === 'speech'">
        <div class="settings-panel settings-accent">
          <div class="settings-link">
            <span>{{ t('Preferred pronunciation accent') }}</span>
            <NRadioGroup name="pronunciation-accent" :aria-label="t('Preferred pronunciation accent')"
              :value="pronunciationAccent" @update:value="setPronunciationAccent">
              <NRadioButton value="american">{{ t('American') }}</NRadioButton>
              <NRadioButton value="british">{{ t('British') }}</NRadioButton>
            </NRadioGroup>
          </div>
        </div>
        <SpeechSettings />
      </template>
      <DictionarySettings v-else-if="section === 'dictionary'" />
      <BackupSettings v-else-if="section === 'backup'" />
      <NCard v-else class="settings-card">
        <div class="library-form">
          <p>{{ connection === 'connected' ? t('Connected') : t('Connection unavailable') }}</p>
          <NAlert v-if="owner.error.value" type="error">
            {{ translateError(owner.error.value) }} <NButton text @click="owner.reload">{{ t('Retry') }}</NButton>
          </NAlert>
          <form class="library-form" @submit.prevent="runAccount(() => study('settings/timezone', [timezone], { write: true }))">
            <label for="owner-timezone">{{ t('Study timezone (IANA)') }}</label>
            <NInput v-model:value="timezone" :disabled="accountBusy || !owner.data.value"
              :input-props="{ id: 'owner-timezone' }" placeholder="Asia/Shanghai" />
            <NButton attr-type="submit" :disabled="accountBusy || !timezone">{{ t('Save timezone') }}</NButton>
          </form>
          <NAlert v-if="accountError" type="error">{{ translateError(accountError) }}</NAlert>
          <NButton :disabled="accountBusy" @click="runAccount(signOut)">{{ t('Sign out') }}</NButton>
        </div>
      </NCard>
    </template>
  </section>
</template>
