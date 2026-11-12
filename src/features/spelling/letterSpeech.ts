import type { PronunciationAccent } from '../../ui/pronunciationAccent'

export function createLetterSpeech() {
  let current: SpeechSynthesisUtterance | undefined
  function stop() {
    if (!current) return
    current = undefined
    try { window.speechSynthesis?.cancel() } catch { /* Speech is optional. */ }
  }
  function say(letter: string, accent: PronunciationAccent) {
    if (!/^[a-z]$/i.test(letter) || typeof SpeechSynthesisUtterance === 'undefined') return
    try {
      const engine = window.speechSynthesis
      if (!engine) return
      stop()
      const utterance = new SpeechSynthesisUtterance(letter.toUpperCase())
      utterance.lang = accent === 'british' ? 'en-GB' : 'en-US'
      // Device voices keep pronunciation available without a per-key network request.
      const voice = engine.getVoices().find((item) => item.localService && item.lang.toLowerCase() === utterance.lang.toLowerCase())
      if (!voice) return
      utterance.voice = voice
      const done = () => { if (current === utterance) current = undefined }
      utterance.onend = done
      utterance.onerror = done
      current = utterance
      engine.speak(utterance)
    } catch { /* Speech cannot interrupt input. */ }
  }
  return { say, stop }
}
