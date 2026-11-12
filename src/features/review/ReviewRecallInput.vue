<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { NInput, type InputInst } from 'naive-ui'
import { t } from '../../i18n/useI18n'
import { spellingKeyboard } from '../../../shared/domain/spelling'
import SpellingKeyboard from '../spelling/SpellingKeyboard.vue'
import SpellingTiles from '../spelling/SpellingTiles.vue'

const answer = defineModel<string>({ required: true })
const props = defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ submit: [] }>()
const keyboard = spellingKeyboard('', 'full', false)
const screenKeyboard = ref(true)
const input = ref<InputInst>()
const composing = ref(false)
const letters = computed(() => [...answer.value.normalize('NFC')].slice(-40))

function edit(character: string, erase = false) {
  if (props.disabled || composing.value) return
  const field = input.value?.inputElRef
  const start = field?.selectionStart ?? answer.value.length
  const end = field?.selectionEnd ?? start
  const from = erase && start === end ? start - ([...answer.value.slice(0, start)].at(-1)?.length ?? 0) : start
  answer.value = (answer.value.slice(0, from) + character + answer.value.slice(end)).slice(0, 1000)
  void nextTick(() => {
    if (window.matchMedia('(pointer: fine)').matches) field?.focus({ preventScroll: true })
    field?.setSelectionRange(from + character.length, from + character.length)
  })
}

function onEnter(event: KeyboardEvent) {
  if (props.disabled || !answer.value.trim() || composing.value || event.isComposing || event.keyCode === 229
    || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || document.querySelector('dialog[open], [aria-modal="true"]')) return
  event.preventDefault()
  emit('submit')
}
</script>

<template>
  <div class="review-blind-input">
    <NInput ref="input" v-model:value="answer" :readonly="disabled" :maxlength="1000"
      :placeholder="t('Type your recall (optional)')" :input-props="{
        'aria-label': t('Type your recall'), autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
      }" @keydown.enter="onEnter" @compositionstart="composing = true" @compositionend="composing = false"
      @focusout="composing = false" />
    <SpellingTiles v-if="letters.length" :letters="letters" />
    <button type="button" class="library-back review-keyboard-toggle" :aria-expanded="screenKeyboard"
      @click="screenKeyboard = !screenKeyboard">{{ t(screenKeyboard ? 'Hide keyboard' : 'Show keyboard') }}</button>
    <SpellingKeyboard v-if="screenKeyboard" :keys="keyboard" :disabled="disabled" :show-symbols-directly="false"
      @key="edit" @erase="edit('', true)" />
  </div>
</template>

<style scoped>
.review-blind-input { display: grid; gap: 8px; min-width: 0; }
.review-blind-input :deep(.spell-keyboard) { width: 100%; gap: 5px; }
.review-blind-input :deep(.spell-keyboard button) { min-height: 44px; font-size: 1.1rem; }
.review-keyboard-toggle { justify-self: end; min-height: 36px; }
</style>
