<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { ref, watch } from 'vue'
import { NAlert, NButton, NCard, NInput, NInputNumber, NRadioButton, NRadioGroup } from 'naive-ui'
import LanguagePicker from '../../i18n/LanguagePicker.vue'
import BackupSettings from './BackupSettings.vue'
import SpeechSettings from '../speech/SpeechSettings.vue'
import AppIcon from '../../components/AppIcon.vue'
import { useAppearance } from '../../ui/appearance'
import { connection, signOut, study, writeDailyNewWords } from '../../api/client'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { useLibraryAction } from '../library/library-ui'

const { appearance, busy, error, setAppearance } = useAppearance()
const dailyNewWords = ref(10)
const { busy: savingDailyNewWords, error: dailyNewWordsError, run } = useLibraryAction()
const timezone = ref('')
const { busy: accountBusy, error: accountError, run: runAccount } = useLibraryAction()
const owner = useLibraryQuery(() => null, (_key, signal) => study('settings/owner', [], { signal }))
watch(() => owner.data.value?.dailyNewWords, (value) => { if (value !== undefined) dailyNewWords.value = value })
watch(() => owner.data.value?.timezone, (value) => { if (value) timezone.value = value })
function saveDailyNewWords(value: number | null) {
  if (value === null) return
  void run(async () => {
    await writeDailyNewWords(value)
    dailyNewWords.value = value
  })
}
</script>

<template>
  <section class="page">
    <header class="page-intro">
      <h1>{{ t('Settings') }}</h1>
      <p>{{ t('Make Lexyn feel at home on this device.') }}</p>
    </header>
    <NCard class="settings-card">
      <div class="setting-row">
        <span class="setting-icon"><AppIcon name="language" /></span>
        <div class="setting-copy">
          <h2>{{ t('Language') }}</h2>
          <p>{{ t('Choose the display language for this browser.') }}</p>
        </div>
        <LanguagePicker />
      </div>
    </NCard>
    <NCard class="settings-card">
      <div class="setting-row">
        <span class="setting-icon"><AppIcon name="appearance" /></span>
        <div class="setting-copy">
          <h2>{{ t('Appearance') }}</h2>
          <p>{{ t('Choose a theme for this browser.') }}</p>
        </div>
        <NRadioGroup name="appearance" :aria-label="t('Appearance')" :value="appearance" :disabled="busy"
          @update:value="setAppearance">
          <NRadioButton value="system">{{ t('System') }}</NRadioButton>
          <NRadioButton value="light">{{ t('Light') }}</NRadioButton>
          <NRadioButton value="dark">{{ t('Dark') }}</NRadioButton>
        </NRadioGroup>
      </div>
      <NAlert v-if="error" class="settings-error" type="error" role="alert">{{ translateError(error) }}</NAlert>
    </NCard>
    <NCard class="settings-card">
      <div class="setting-row">
        <span class="setting-icon"><AppIcon name="learn" /></span>
        <div class="setting-copy">
          <h2>{{ t('Daily new words') }}</h2>
          <p>{{ t('One shared limit across all active decks. Choose from 1 to 100.') }}</p>
        </div>
        <NInputNumber :value="dailyNewWords" :min="1" :max="100" :step="1" :disabled="savingDailyNewWords || !owner.data.value"
          :input-props="{ 'aria-label': t('Daily new words') }" @update:value="saveDailyNewWords" />
      </div>
      <NAlert v-if="dailyNewWordsError" class="settings-error" type="error" role="alert">
        {{ translateError(dailyNewWordsError) }}
      </NAlert>
    </NCard>
    <NCard class="settings-card" :title="t('Owner account')">
      <div class="library-form">
        <p>{{ connection === 'connected' ? t('Connected') : t('Connection unavailable') }}</p>
        <NAlert v-if="owner.error.value" type="error">{{ translateError(owner.error.value) }} <NButton text @click="owner.reload">{{ t('Retry') }}</NButton></NAlert>
        <form class="library-form" @submit.prevent="runAccount(() => study('settings/timezone', [timezone], { write: true }))">
          <label for="owner-timezone">{{ t('Study timezone (IANA)') }}</label>
          <NInput v-model:value="timezone" :disabled="accountBusy || !owner.data.value" :input-props="{ id: 'owner-timezone' }" placeholder="Asia/Shanghai" />
          <NButton attr-type="submit" :disabled="accountBusy || !timezone">{{ t('Save timezone') }}</NButton>
        </form>
        <NAlert v-if="accountError" type="error">{{ translateError(accountError) }}</NAlert>
        <NButton :disabled="accountBusy" @click="runAccount(signOut)">{{ t('Sign out') }}</NButton>
      </div>
    </NCard>
    <SpeechSettings />
    <BackupSettings />
  </section>
</template>
