<script setup lang="ts">
import { t } from '../../i18n/useI18n'
defineProps<{ letters: string[]; typo?: number; correct?: boolean }>()
</script>

<template>
  <div class="spell-answer-tiles" :class="{ 'spell-answer-correct': correct }">
    <span class="visually-hidden" role="status">{{ correct ? t('Spelling correct') : typo !== undefined ? t('Incorrect letter. Try the word again.') : '' }}</span>
    <Transition name="spell-tiles">
      <div v-if="letters.length" class="spell-answer-row" role="group" :aria-label="t('Your spelling so far')">
        <span v-for="(letter, index) in letters" :key="index" class="spell-answer-tile"
          :class="{ 'spell-answer-tile-incorrect': index === typo }">{{ letter === ' ' ? '·' : letter }}</span>
      </div>
    </Transition>
  </div>
</template>
