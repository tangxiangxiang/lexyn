import { computed, onMounted, onUnmounted, readonly, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

function chooseVoice(voices: SpeechSynthesisVoice[]) {
  return voices.find((voice) => voice.lang.toLowerCase() === 'en-us')
    ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('en-'))
    ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('en'))
}

export function useSpeech(target: MaybeRefOrGetter<string>, voiceHint?: MaybeRefOrGetter<boolean | undefined>) {
  const available = ref(typeof window !== 'undefined'
    && typeof window.speechSynthesis?.getVoices === 'function'
    && typeof window.SpeechSynthesisUtterance === 'function')
  const voice = ref<SpeechSynthesisVoice>()
  const error = ref('')
  const speaking = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function updateVoices() {
    if (!available.value) return
    const voices = window.speechSynthesis.getVoices()
    voice.value = chooseVoice(voices)
    if (voice.value) {
      available.value = true
      error.value = ''
      if (timer) clearTimeout(timer)
    } else if (voices.length) {
      available.value = false
      error.value = 'No English voice is installed in this browser.'
      if (timer) clearTimeout(timer)
    }
  }

  const canSpeak = computed(() => available.value && !!voice.value
    && (toValue(voiceHint) !== false) && !!toValue(target).trim())

  onMounted(() => {
    if (!available.value) {
      error.value = 'Speech synthesis is not available in this browser.'
      return
    }
    window.speechSynthesis.addEventListener('voiceschanged', updateVoices)
    updateVoices()
    if (!voice.value && available.value) {
      timer = setTimeout(() => {
        if (!voice.value) {
          available.value = false
          error.value = 'No English voice is available on this device.'
        }
      }, 2500)
    }
  })

  watch(() => toValue(voiceHint), (hint) => {
    if (hint === false) {
      available.value = false
      error.value = 'The previous learning session has no available English voice. You can change to Copy.'
    }
  })

  function speak() {
    if (!canSpeak.value) return
    error.value = ''
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(toValue(target))
    utterance.voice = voice.value!
    utterance.lang = voice.value!.lang
    utterance.onstart = () => { speaking.value = true }
    utterance.onend = () => { speaking.value = false }
    utterance.onerror = () => {
      speaking.value = false
      error.value = 'Speech could not be played. Check that your device has an English voice.'
    }
    window.speechSynthesis.speak(utterance)
  }

  watch(() => toValue(target), () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      speaking.value = false
    }
  })

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.removeEventListener('voiceschanged', updateVoices)
      window.speechSynthesis.cancel()
    }
  })

  return { available: readonly(available), error: readonly(error), speaking: readonly(speaking), speak }
}
