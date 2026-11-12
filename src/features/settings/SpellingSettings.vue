<script setup lang="ts">
import { NAlert, NButton, NRadioButton, NRadioGroup, NSelect, NSwitch } from 'naive-ui'
import { study } from '../../api/client'
import { t, translateError } from '../../i18n/useI18n'
import type { KeyboardLayout, SpellingPreferences } from '../../../shared/domain/spelling'
import { useLibraryAction } from '../library/library-ui'
import { useLibraryQuery } from '../library/useLibraryQuery'

const { data, error: loadError, reload } = useLibraryQuery(() => null,
  (_key, signal) => study('settings/spelling', [], { signal }))
const { busy, error, run } = useLibraryAction()

function save<K extends keyof SpellingPreferences>(key: K, value: SpellingPreferences[K]) {
  if (!data.value) return
  void run(() => study('settings/save-spelling', [{ [key]: value }], { write: true }))
}
</script>

<template>
  <NAlert v-if="loadError || error" type="error" role="alert">
    {{ translateError(loadError || error) }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
  </NAlert>
  <template v-if="data">
    <div class="settings-link">
      <span>{{ t('Keyboard layout') }}</span>
      <NRadioGroup name="spelling-keyboard" :aria-label="t('Keyboard layout')" :value="data.keyboard" :disabled="busy"
        @update:value="(value) => save('keyboard', value as KeyboardLayout)">
        <NRadioButton value="full">{{ t('Full keyboard') }}</NRadioButton>
        <NRadioButton value="simplified">{{ t('Simplified keyboard') }}</NRadioButton>
      </NRadioGroup>
    </div>
    <label class="settings-link">
      <span>{{ t('Syllable guide') }}</span>
      <NSwitch :aria-label="t('Syllable guide')" :value="data.syllables" :disabled="busy"
        @update:value="(value) => save('syllables', value)" />
    </label>
    <label class="settings-link">
      <span>{{ t('Strict spelling') }}</span>
      <NSwitch :aria-label="t('Strict spelling')" :value="data.strict" :disabled="busy"
        @update:value="(value) => save('strict', value)" />
    </label>
    <div class="settings-link">
      <span>{{ t('Wrong-word retries') }}</span>
      <NSelect :aria-label="t('Wrong-word retries')" :value="data.retryLimit" :disabled="busy"
        :options="[{ label: t('Off'), value: 0 }, ...[1, 2, 3].map((value) => ({ label: String(value), value }))]"
        @update:value="(value) => save('retryLimit', value)" />
    </div>
    <label class="settings-link">
      <span>{{ t('Speak typed letters') }}</span>
      <NSwitch :aria-label="t('Speak typed letters')" :value="data.speakLetters" :disabled="busy"
        @update:value="(value) => save('speakLetters', value)" />
    </label>
    <p class="spelling-settings-note">{{ t('Saved on the server and applied when a new session starts. Letter speech uses installed device voices.') }}</p>
  </template>
</template>
