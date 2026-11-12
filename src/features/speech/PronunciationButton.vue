<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import type { SpeechVoice } from '../../../shared/contracts/speech'
import { formatPhonetic, type PhoneticVariants } from '../../../shared/domain/dictionary'
import type { PronunciationAccent } from '../../ui/pronunciationAccent'
import AppIcon from '../../components/AppIcon.vue'
import { t, translateError } from '../../i18n/useI18n'
import { useSpeech } from './useSpeech'

const props = withDefaults(defineProps<{
  entryId?: string; voiceId?: SpeechVoice; revision?: number; scope?: string; disabled?: boolean; label: string; preload?: boolean
  showPhonetic?: boolean
  phonetics?: PhoneticVariants; legacyPhonetic?: string; accent?: PronunciationAccent
}>(), { showPhonetic: true })
const { state, error, toggle } = useSpeech(
  () => props.voiceId ? { voiceId: props.voiceId } : { entryId: props.entryId! },
  () => [props.entryId, props.revision, props.scope, props.voiceId].join('/'),
  () => !!props.preload && !!props.entryId,
)
const pronunciation = computed(() => {
  const accent = props.accent ?? 'american'
  const preferred = formatPhonetic(props.phonetics?.[accent])
  if (preferred) return { value: preferred, accent }
  const generic = formatPhonetic(props.phonetics?.unspecified) || formatPhonetic(props.legacyPhonetic)
  if (generic) return { value: generic, accent: undefined }
  const otherAccent = accent === 'american' ? 'british' : 'american'
  const other = formatPhonetic(props.phonetics?.[otherAccent])
  return other ? { value: other, accent: otherAccent } : undefined
})
const buttonLabel = computed(() => {
  if (state.value === 'playing') return t('Pause pronunciation')
  if (pronunciation.value) {
    if (props.showPhonetic === false) return t(props.label)
    const accent = pronunciation.value.accent
    return accent
      ? t('Play {accent} pronunciation {phonetic}', { accent: t(accent === 'british' ? 'British' : 'American'), phonetic: pronunciation.value.value })
      : t('Play pronunciation {phonetic}', { phonetic: pronunciation.value.value })
  }
  return t(state.value === 'loading' ? 'Loading pronunciation…' : props.label)
})
</script>

<template>
  <div>
    <NButton :size="pronunciation ? 'medium' : 'small'" :text="!!pronunciation"
      class="pronunciation-button" :class="{ 'pronunciation-plain': pronunciation }"
      :loading="state === 'loading' && !pronunciation"
      :disabled="disabled || state === 'loading'" :aria-label="buttonLabel" @click="toggle">
      <template v-if="pronunciation && props.showPhonetic !== false">
        <span class="pronunciation-phonetic">
          {{ pronunciation.value }}
        </span>
        <span class="pronunciation-icon" aria-hidden="true">
          <AppIcon :name="state === 'playing' ? 'pause' : 'speaker'" />
        </span>
      </template>
      <template v-else-if="pronunciation">
        <span class="pronunciation-icon" aria-hidden="true">
          <AppIcon :name="state === 'playing' ? 'pause' : 'speaker'" />
        </span>
      </template>
      <template v-else>{{ buttonLabel }}</template>
    </NButton>
    <p v-if="error" class="library-muted" role="status">{{ translateError(error) }}</p>
  </div>
</template>

<style scoped>
.pronunciation-button { display: inline-flex; align-items: center; gap: 8px; }
.pronunciation-phonetic { font-size: 1rem; font-variant-numeric: lining-nums; }
.pronunciation-button :deep(.n-button__content) { gap: 8px; }
.pronunciation-icon { display: inline-grid; place-items: center; flex: 0 0 18px; width: 18px; height: 18px; }
.pronunciation-icon :deep(svg) { display: block; width: 18px; height: 18px; }
.pronunciation-plain { padding-inline: 4px !important; color: inherit !important; background: transparent !important; min-height: 44px; border-radius: 8px; }
.pronunciation-plain :deep(.n-button__content) { font-size: 1.05rem; }
@media (hover: hover) and (pointer: fine) {
  .pronunciation-plain:hover { background: var(--glass, #a1d8ff24) !important; }
}
</style>
