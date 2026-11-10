<script setup lang="ts">
import { NButton } from 'naive-ui'
import type { SpeechVoice } from '../../../shared/contracts/speech'
import { t, translateError } from '../../i18n/useI18n'
import { useSpeech } from './useSpeech'

const props = defineProps<{
  entryId?: string; voiceId?: SpeechVoice; revision?: number; scope?: string; disabled?: boolean; label: string; preload?: boolean
}>()
const { state, error, toggle } = useSpeech(
  () => props.voiceId ? { voiceId: props.voiceId } : { entryId: props.entryId! },
  () => [props.entryId, props.revision, props.scope, props.voiceId].join('/'),
  () => !!props.preload && !!props.entryId,
)
</script>

<template>
  <div>
    <NButton size="small" :loading="state === 'loading'" :disabled="disabled || state === 'loading'"
      @click="toggle">{{ t(state === 'loading' ? 'Loading pronunciation…' : state === 'playing' ? 'Pause pronunciation' : label) }}</NButton>
    <p v-if="error" class="library-muted" role="status">{{ translateError(error) }}</p>
  </div>
</template>
