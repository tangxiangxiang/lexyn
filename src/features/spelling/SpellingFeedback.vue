<script setup lang="ts">
import { t } from '../../i18n/useI18n'
import type { SpellingFeedback } from '../../../shared/domain/learning'
defineProps<{ feedback: SpellingFeedback[] }>()
</script>

<template>
  <div v-if="feedback.length" class="learn-spelling" aria-live="polite"
    :aria-label="feedback.map((part) => part.actual + ': ' + t(part.status)).join(', ')">
    <span v-for="(part, index) in feedback" :key="index" :class="'letter-' + part.status"
      aria-hidden="true">{{ part.actual === ' ' ? '·' : part.actual }}</span>
  </div>
</template>
