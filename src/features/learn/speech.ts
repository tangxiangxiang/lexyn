import { computed, onMounted, onUnmounted, readonly, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

type SpeechStatus = 'unsupported' | 'loading' | 'ready' | 'unavailable' | 'error'

const messages: Record<SpeechStatus, string> = {
  unsupported: 'Speech synthesis is not available in this browser.',
  loading: 'Waiting for an English voice…',
  ready: '',
  unavailable: 'No English voice is available on this device.',
  error: 'Speech could not be played. Try again or choose Copy.',
}

function chooseVoice(voices: SpeechSynthesisVoice[]) {
  return voices.find((voice) => voice.lang.toLowerCase() === 'en-us')
    ?? voices.find((voice) => /^en(?:-|$)/i.test(voice.lang))
}

export function useSpeech(target: MaybeRefOrGetter<string>) {
  const synthesis = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const Utterance = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined
  const supported = typeof synthesis?.getVoices === 'function' && typeof Utterance === 'function'
  const status = ref<SpeechStatus>(supported ? 'loading' : 'unsupported')
  const available = computed(() => status.value === 'ready')
  const canPlay = computed(() => available.value || status.value === 'error')
  const message = computed(() => messages[status.value])
  const speaking = ref(false)
  let voice: SpeechSynthesisVoice | undefined
  let active: SpeechSynthesisUtterance | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function stop() {
    const wasActive = !!active
    active = undefined
    speaking.value = false
    if (wasActive) synthesis?.cancel()
  }

  function updateVoices() {
    const voices = synthesis!.getVoices()
    voice = chooseVoice(voices)
    if (!voice && !voices.length && status.value === 'loading') return
    clearTimeout(timer)
    if (!voice) stop()
    status.value = voice ? 'ready' : 'unavailable'
  }

  onMounted(() => {
    if (!supported) return
    synthesis.addEventListener('voiceschanged', updateVoices)
    updateVoices()
    if (status.value === 'loading') {
      timer = setTimeout(() => { status.value = 'unavailable' }, 2500)
    }
  })

  function speak() {
    const text = toValue(target)
    if (!synthesis || !Utterance || !voice || !text.trim()) return
    stop()
    status.value = 'ready'
    try {
      const utterance = new Utterance(text)
      utterance.voice = voice
      utterance.lang = voice.lang
      active = utterance
      utterance.onstart = () => { if (active === utterance) speaking.value = true }
      utterance.onend = () => {
        if (active !== utterance) return
        active = undefined
        speaking.value = false
      }
      utterance.onerror = () => {
        if (active !== utterance) return
        active = undefined
        speaking.value = false
        status.value = 'error'
      }
      synthesis.speak(utterance)
    } catch {
      stop()
      status.value = 'error'
    }
  }

  watch(() => toValue(target), stop, { flush: 'sync' })
  onUnmounted(() => {
    clearTimeout(timer)
    if (supported) synthesis.removeEventListener('voiceschanged', updateVoices)
    stop()
  })

  return { available, canPlay, message, speaking: readonly(speaking), speak }
}
