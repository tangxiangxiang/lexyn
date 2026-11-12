<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch, type InputHTMLAttributes } from 'vue'
import { NAlert, NButton, NInput, NProgress } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import { t } from '../../i18n/useI18n'
import { isSpellingCorrect, type LearnMode, type SpellingFeedback as Feedback } from '../../../shared/domain/learning'
import type { spellingKeyboard } from '../../../shared/domain/spelling'
import type { PronunciationAccent } from '../../ui/pronunciationAccent'
import SpellingDisplay from './SpellingDisplay.vue'
import SpellingFeedback from './SpellingFeedback.vue'
import SpellingKeyboard from './SpellingKeyboard.vue'
import { createLetterSpeech } from './letterSpeech'

const props = defineProps<{
  mode: LearnMode
  term: string
  strict: boolean
  busy: boolean
  correct: boolean
  keys: ReturnType<typeof spellingKeyboard>
  syllables?: string[]
  speakLetters: boolean
  accent: PronunciationAccent
  progress: number
  initialInput?: string
  submit: (answer: string, partial: boolean) => Promise<{ correct: boolean; feedback: Feedback[] } | undefined>
  finish: () => Promise<unknown>
}>()

type Phase = 'waiting' | 'typing' | 'submitting' | 'error' | 'retry' | 'correct' | 'advancing'
const phase = ref<Phase>(props.correct ? 'correct' : 'waiting')
const input = ref(props.initialInput ?? '')
const feedback = ref<Feedback[]>([])
const message = ref('')
const inputElement = ref<InstanceType<typeof NInput>>()
const nextButton = ref<InstanceType<typeof NButton>>()
const keyboardVisible = ref(true)
const composing = ref(false)
const typo = ref<number>()
const speech = createLetterSpeech()
let timer: number | undefined
let disposed = false

const typed = computed(() => [...input.value.normalize('NFC')])
const target = computed(() => [...props.term.normalize('NFC')])
const locked = computed(() => props.busy || props.correct || phase.value === 'submitting'
  || phase.value === 'advancing' || (phase.value === 'error' && props.strict))
const inputProps = computed<InputHTMLAttributes>(() => ({
  'aria-label': t(props.mode === 'copy' ? 'Copy the word' : 'Type the dictated word'),
  autocomplete: 'off', autocapitalize: 'none', spellcheck: false, enterkeyhint: 'done',
  inputmode: keyboardVisible.value ? 'none' : 'text',
  onCompositionstart: () => { composing.value = true },
  onCompositionend: () => { composing.value = false },
  onBlur: () => { composing.value = false },
  onPaste: (event: ClipboardEvent) => { if (props.strict) event.preventDefault() },
  onDrop: (event: DragEvent) => { if (props.strict) event.preventDefault() },
  onBeforeinput: (event: InputEvent) => {
    if (props.strict && ['insertReplacementText', 'insertFromPaste', 'insertFromDrop'].includes(event.inputType)) event.preventDefault()
  },
}))

function focusInput() {
  void nextTick(() => { if (!disposed) inputElement.value?.focus() })
}

function toggleKeyboard() {
  keyboardVisible.value = !keyboardVisible.value
  if (!props.correct) focusInput()
}

function clearTimer() {
  window.clearTimeout(timer)
  timer = undefined
}

onMounted(() => { if (props.correct) void nextTick(() => nextButton.value?.$el.focus()); else focusInput() })
onScopeDispose(() => { disposed = true; clearTimer(); speech.stop() })
watch(() => props.speakLetters, (value) => { if (!value) speech.stop() })
watch(() => props.mode, () => {
  clearTimer()
  typo.value = undefined
  feedback.value = []
  message.value = ''
  input.value = ''
  phase.value = props.correct ? 'correct' : 'waiting'
  speech.stop()
  focusInput()
})
watch(() => props.term, () => {
  feedback.value = []
  message.value = ''
  if (phase.value !== 'error') clearTimer()
})
watch(() => props.correct, (correct, previous) => {
  if (phase.value === 'submitting' || phase.value === 'advancing') return
  if (correct) {
    phase.value = 'correct'
    void nextTick(() => nextButton.value?.$el.focus())
  } else if (previous) {
    phase.value = 'retry'
    input.value = ''
    focusInput()
  }
})

function clearFailedInput(answer: string) {
  if (input.value !== answer) return
  input.value = ''
  typo.value = undefined
  feedback.value = []
  message.value = ''
  phase.value = 'retry'
  focusInput()
}

function delayReset(answer: string, duration: number) {
  clearTimer()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  timer = window.setTimeout(() => clearFailedInput(answer), reduced ? 0 : duration)
}

async function advance() {
  if (!props.correct || props.busy || phase.value === 'advancing') return
  phase.value = 'advancing'
  await props.finish()
  if (disposed) return
  phase.value = props.correct ? 'correct' : 'retry'
  if (props.correct) void nextTick(() => nextButton.value?.$el.focus())
}

async function submit(partial = false) {
  if (locked.value || composing.value) return
  const answer = input.value
  if (!answer.length || (!partial && !answer.trim())) { message.value = 'Type your answer before submitting.'; return }
  clearTimer()
  if (partial) typo.value = typed.value.findIndex((letter, index) => letter.toLowerCase() !== target.value[index]?.toLowerCase())
  phase.value = 'submitting'
  message.value = ''
  feedback.value = []
  const result = await props.submit(answer, partial)
  if (disposed) return
  if (!result) {
    // Keep the draft on transport failure so an explicit retry uses the same request.
    phase.value = 'retry'
    focusInput()
    return
  }
  if (result.correct) {
    phase.value = 'correct'
    await advance()
    return
  }
  phase.value = 'error'
  if (partial) {
    delayReset(answer, 180)
  } else {
    feedback.value = result.feedback
    message.value = 'Not quite. Check the marked letters and try again.'
    if (props.strict) delayReset(answer, 650)
    focusInput()
  }
}

watch([input, composing], ([value, inComposition], [previous]) => {
  if (inComposition || locked.value || !value || value === props.initialInput && phase.value === 'waiting') return
  if (value !== previous) {
    typo.value = undefined
    phase.value = 'typing'
    if (props.speakLetters && value.length >= previous.length) {
      const prior = [...previous]
      const current = [...value]
      const start = current.findIndex((character, index) => character !== prior[index])
      if (start >= 0) speech.say(current[start], props.accent)
    }
  }
  if (props.mode !== 'copy' || !props.strict) return
  if (isSpellingCorrect(props.term, value)) void submit()
  else if (typed.value.some((letter, index) => letter.toLowerCase() !== target.value[index]?.toLowerCase())) void submit(true)
}, { flush: 'post' })

function edit(text: string, erase = false) {
  if (locked.value || composing.value) return
  const element = inputElement.value?.inputElRef
  const start = element?.selectionStart ?? input.value.length
  const end = element?.selectionEnd ?? start
  const from = erase && start === end ? start - ([...input.value.slice(0, start)].at(-1)?.length ?? 0) : start
  input.value = (input.value.slice(0, from) + text + input.value.slice(end)).slice(0, 1000)
  void nextTick(() => {
    if (disposed || locked.value) return
    element?.focus()
    element?.setSelectionRange(from + text.length, from + text.length)
  })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.defaultPrevented) return
  const onNext = event.target === nextButton.value?.$el
  if (!onNext && event.target !== inputElement.value?.inputElRef) return
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || composing.value || event.isComposing || event.keyCode === 229) {
    if (onNext) event.preventDefault()
    return
  }
  event.preventDefault()
  if (!event.repeat) {
    if (props.correct) void advance()
    else void submit(typo.value !== undefined)
  }
}
</script>

<template>
  <article class="spell-stage" @keydown="onKeydown">
    <div class="spell-guided-toolbar">
      <div class="spell-stage-tools" role="group" :aria-label="t('Spelling tools')">
        <slot name="hint" />
        <button type="button" class="icon-control" :aria-label="t('Check spelling')" :disabled="locked || (!input.trim() && typo === undefined)"
          @click="submit(typo !== undefined)"><AppIcon name="checkCircle" /></button>
        <button type="button" class="icon-control" :aria-label="t('On-screen keyboard')" :aria-pressed="keyboardVisible"
          @click="toggleKeyboard"><AppIcon name="keyboard" /></button>
      </div>
      <NProgress class="spell-guided-progress" type="circle" :percentage="progress" :show-indicator="false" :aria-label="t('Session progress')" />
      <slot name="menu" />
    </div>
    <div class="spell-clue">
      <slot name="before-word" />
      <div class="spell-entry">
        <h2 v-if="term" class="visually-hidden">{{ term }}</h2>
        <div class="spell-entry-field">
          <SpellingDisplay :term="term" :input="input" :typo="typo" :syllables="syllables" />
          <NInput ref="inputElement" v-model:value="input" class="spell-entry-input"
            :readonly="locked" :disabled="correct && phase !== 'advancing'" :maxlength="1000" :input-props="inputProps" />
        </div>
      </div>
      <slot name="clues" />
    </div>
    <div v-if="feedback.length || message" class="learn-practice-area">
      <SpellingFeedback :feedback="feedback" />
      <NAlert v-if="message" type="info" role="status">{{ t(message) }}</NAlert>
    </div>
    <slot name="messages" />
    <div v-if="correct && phase !== 'submitting' && phase !== 'advancing'" class="learn-actions learn-session-actions">
      <NButton ref="nextButton" type="primary" :disabled="busy" @click="advance">{{ t('Next word') }}</NButton>
    </div>
    <div class="spell-keyboard-area">
      <div class="spell-answer-tiles" :class="{ 'spell-answer-correct': correct }">
        <span class="visually-hidden" role="status">{{ correct ? t('Spelling correct') : typo !== undefined ? t('Incorrect letter. Try the word again.') : '' }}</span>
        <Transition name="spell-tiles">
          <div v-if="typed.length" class="spell-answer-row" role="group" :aria-label="t('Your spelling so far')">
            <span v-for="(letter, index) in typed" :key="index" class="spell-answer-tile"
              :class="{ 'spell-answer-tile-incorrect': index === typo }">{{ letter === ' ' ? '·' : letter }}</span>
          </div>
        </Transition>
      </div>
      <SpellingKeyboard v-if="keyboardVisible" :key="keys.layout + mode" :keys="keys" :disabled="locked || composing"
        :show-symbols-directly="!!term && mode === 'copy'" @key="edit" @erase="edit('', true)" />
    </div>
  </article>
</template>
