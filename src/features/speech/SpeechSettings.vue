<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NCheckbox, NInput, NSelect } from 'naive-ui'
import { playbackRates, speechVoices, type PlaybackRate, type SpeechVoice } from '../../../shared/contracts/speech'
import { t, translateError } from '../../i18n/useI18n'
import { useLibraryAction } from '../library/library-ui'
import { useLibraryQuery } from '../library/useLibraryQuery'
import PronunciationButton from './PronunciationButton.vue'
import { speechSettings } from './useSpeech'
import { vocabulary } from '../library/vocabulary-api'
import type { VocabularyStatus } from '../../../shared/contracts/vocabulary'

const { data, error: loadError, reload } = useLibraryQuery(() => null, (_key, signal) => speechSettings.read(signal))
const textAI = useLibraryQuery(() => null, (_key, signal) => vocabulary.status(signal))
const textStatus: Record<VocabularyStatus['status'], string> = {
  missing: 'Save a usable MiniMax key in Pronunciation before generating vocabulary.',
  unavailable: 'The saved MiniMax key is unavailable.',
  unverified: 'Key saved. Text access will be checked on the first generation.',
  available: 'MiniMax text generation is available.',
  auth: 'MiniMax rejected text access for the saved key. Check its text API permissions.',
  quota: 'MiniMax text quota or balance is insufficient.',
}
const { busy, error, run } = useLibraryAction()
const voiceId = ref<SpeechVoice>()
const playbackRate = ref<PlaybackRate>(1)
const apiKey = ref('')
const clearKey = ref(false)
const saved = ref(false)
const options = computed(() => Object.entries(speechVoices).map(([value, label]) => ({ value, label: t(label) })))
watch(data, (value) => {
  if (!value) return
  voiceId.value = value.voiceId
  playbackRate.value = value.playbackRate
})
function save() {
  if (!voiceId.value) return
  const values = { voiceId: voiceId.value, playbackRate: playbackRate.value,
    apiKey: clearKey.value ? undefined : apiKey.value.trim() || undefined, clearKey: clearKey.value }
  void run(async () => {
    await speechSettings.save(values)
    apiKey.value = ''
    clearKey.value = false
    await Promise.all([reload(), textAI.reload()])
    saved.value = true
  })
}
</script>

<template>
  <NCard class="settings-card" :title="t('Pronunciation')">
    <NAlert v-if="loadError" type="error">
      {{ translateError(loadError) }} <NButton text @click="reload">{{ t('Try again') }}</NButton>
    </NAlert>
    <form v-else-if="data && voiceId" class="library-form" @submit.prevent="save">
      <p v-if="data.credentialStatus !== 'unavailable'" class="library-muted">{{ t(data.credentialStatus === 'configured'
        ? 'MiniMax speech is configured.' : 'MiniMax speech is not configured on the server.') }}</p>
      <NAlert v-else type="warning">{{ t('The saved MiniMax key cannot be opened. Restore the speech master key or remove and save the API key again.') }}</NAlert>
      <label for="speech-api-key">{{ t('MiniMax API key') }}</label>
      <NInput v-model:value="apiKey" type="password" :maxlength="1024"
        :input-props="{ id: 'speech-api-key', autocomplete: 'new-password' }"
        :placeholder="t(data.credentialStatus === 'configured' ? 'Leave blank to keep the saved key' : 'Enter a MiniMax API key')"
        :disabled="busy || clearKey || data.credentialStatus === 'unavailable'" @update:value="saved = false" />
      <NCheckbox v-if="data.credentialStatus !== 'missing'" v-model:checked="clearKey" :disabled="busy"
        @update:checked="saved = false">{{ t('Remove saved API key') }}</NCheckbox>
      <label for="speech-voice">{{ t('English voice') }}</label>
      <NSelect id="speech-voice" v-model:value="voiceId" :options="options" :disabled="busy"
        :aria-label="t('English voice')" @update:value="saved = false" />
      <PronunciationButton :voice-id="voiceId" label="Preview voice" />
      <label for="speech-rate">{{ t('Playback speed') }}</label>
      <NSelect id="speech-rate" v-model:value="playbackRate" :disabled="busy" :aria-label="t('Playback speed')"
        :options="playbackRates.map((rate) => ({ label: rate.toFixed(1) + '×', value: rate }))"
        @update:value="saved = false" />
      <NButton attr-type="submit" :loading="busy">{{ t('Save pronunciation settings') }}</NButton>
      <p v-if="saved" role="status">{{ t('Pronunciation settings saved.') }}</p>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
    </form>
  </NCard>
  <NCard class="settings-card" :title="t('AI Vocabulary')">
    <NAlert v-if="textAI.error.value" type="error">
      {{ translateError(textAI.error.value) }} <NButton text @click="textAI.reload">{{ t('Retry') }}</NButton>
    </NAlert>
    <template v-else-if="textAI.data.value">
      <p>{{ t('Text model: {model}', { model: textAI.data.value.model }) }}</p>
      <p>{{ t(textStatus[textAI.data.value.status]) }}</p>
    </template>
  </NCard>
</template>
