<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../../i18n/useI18n'
import type { spellingKeyboard } from '../../../shared/domain/spelling'

const props = defineProps<{ keys: ReturnType<typeof spellingKeyboard>; disabled: boolean; showSymbolsDirectly: boolean }>()
const emit = defineEmits<{ key: [character: string]; erase: [] }>()
const symbols = ref(false)
const rows = computed(() => {
  if (!symbols.value && props.keys.layout === 'full') return props.keys.rows
  const keys = symbols.value ? props.keys.symbols : props.keys.rows.flat()
  return Array.from({ length: Math.ceil(keys.length / 10) }, (_, index) => keys.slice(index * 10, index * 10 + 10))
})
</script>

<template>
  <div class="spell-keyboard" :class="{ 'spell-keyboard-simplified': keys.layout === 'simplified' }"
    role="group" :aria-label="t('On-screen keyboard')">
    <div v-for="(row, index) in rows" :key="index" :style="{ '--spelling-key-count': row.length }">
      <button v-for="letter in row" :key="letter" type="button" :disabled="disabled"
        @mousedown.prevent @click="emit('key', letter)">{{ letter }}</button>
    </div>
    <div class="spell-keyboard-extra">
      <button v-if="keys.symbols.length && !showSymbolsDirectly" type="button" :aria-pressed="symbols"
        @mousedown.prevent @click="symbols = !symbols">{{ t('Symbols') }}</button>
      <template v-if="showSymbolsDirectly">
        <button v-for="key in keys.symbols" :key="key" type="button" :disabled="disabled"
          @mousedown.prevent @click="emit('key', key)">{{ key }}</button>
      </template>
      <button v-if="keys.space" type="button" :disabled="disabled" @mousedown.prevent @click="emit('key', ' ')">{{ t('Space') }}</button>
      <button type="button" :aria-label="t('Delete letter')" :disabled="disabled" @mousedown.prevent @click="emit('erase')">⌫</button>
    </div>
  </div>
</template>
