<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NInputNumber, NRadioButton, NRadioGroup } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import { useAppearance } from '../../ui/appearance'
import { readDailyNewWords, writeDailyNewWords } from '../../db/local'
import { useLibraryAction } from '../library/library-ui'

const { appearance, busy, error, setAppearance } = useAppearance()
const dailyNewWords = ref(10)
const { busy: savingDailyNewWords, error: dailyNewWordsError, run } = useLibraryAction()
onMounted(async () => { dailyNewWords.value = await readDailyNewWords() })
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
      <h1>Settings</h1>
      <p>Make Lexyn feel at home on this device.</p>
    </header>
    <NCard class="settings-card">
      <div class="setting-row">
        <span class="setting-icon"><AppIcon name="appearance" /></span>
        <div class="setting-copy">
          <h2>Appearance</h2>
          <p>Choose a theme for this browser.</p>
        </div>
        <NRadioGroup name="appearance" aria-label="Appearance" :value="appearance" :disabled="busy"
          @update:value="setAppearance">
          <NRadioButton value="system">System</NRadioButton>
          <NRadioButton value="light">Light</NRadioButton>
          <NRadioButton value="dark">Dark</NRadioButton>
        </NRadioGroup>
      </div>
      <NAlert v-if="error" class="settings-error" type="error" role="alert">{{ error }}</NAlert>
    </NCard>
    <NCard class="settings-card">
      <div class="setting-row">
        <span class="setting-icon"><AppIcon name="learn" /></span>
        <div class="setting-copy">
          <h2>Daily new words</h2>
          <p>One shared limit across all active decks. Choose from 1 to 100.</p>
        </div>
        <NInputNumber :value="dailyNewWords" :min="1" :max="100" :step="1" :disabled="savingDailyNewWords"
          aria-label="Daily new words" @update:value="saveDailyNewWords" />
      </div>
      <NAlert v-if="dailyNewWordsError" class="settings-error" type="error" role="alert">
        {{ dailyNewWordsError }}
      </NAlert>
    </NCard>
  </section>
</template>
