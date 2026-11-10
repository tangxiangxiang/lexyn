<script setup lang="ts">
import { t } from '../../i18n/useI18n'
import { NButton } from 'naive-ui'
import { useSpeech } from '../learn/speech'

const props = defineProps<{ term: string }>()
const { canPlay, speaking, speak } = useSpeech(() => props.term)
</script>

<template>
  <div v-if="canPlay">
    <NButton size="small" @click="speak">{{ speaking ? t('Playing…') : t('Play pronunciation') }}</NButton>
  </div>
</template>
