<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n/useI18n'

const props = defineProps<{ term: string; input: string; typo?: number; syllables?: string[] }>()
const typed = computed(() => [...props.input.normalize('NFC')])
const target = computed(() => [...props.term.normalize('NFC')])
const shown = computed(() => props.term ? target.value : typed.value)
const groups = computed(() => {
  let start = 0
  return (props.syllables ?? [shown.value.join('')]).map((chunk) => {
    const letters = [...chunk]
    const offset = start
    start += letters.length
    return { letters, offset, current: typed.value.length >= offset && typed.value.length < start }
  })
})
const segments = computed(() => Math.min(props.term ? target.value.length : typed.value.length + 1, 32))

function state(index: number) {
  if (index === props.typo) return 'incorrect'
  if (index < typed.value.length) return 'typed'
  return index === typed.value.length ? 'current' : 'pending'
}
</script>

<template>
  <div v-if="shown.length && shown.length <= 32" class="spell-word-display" aria-hidden="true">
    <div class="spell-prompt">
      <span v-for="{ letters, offset, current } in groups" :key="offset" class="spell-syllable"
        :class="{ 'spell-syllable-current': syllables && current, 'spell-syllable-separated': syllables }">
        <span v-for="(letter, index) in letters" :key="index" :class="'spell-prompt-' + state(offset + index)">
          {{ letter === ' ' ? '\u00a0' : letter }}
        </span>
      </span>
    </div>
    <div class="spell-prompt-progress">
      <span v-for="index in segments" :key="index" :class="'segment-' + state(index - 1)" />
    </div>
  </div>
  <p v-else class="spell-long-answer" aria-hidden="true">{{ term || input || t('Type your answer') }}</p>
</template>
