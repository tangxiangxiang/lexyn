import { ref } from 'vue'

export type PronunciationAccent = 'british' | 'american'

const storageKey = 'lexyn.pronunciationAccent'
const defaultAccent: PronunciationAccent = 'american'

function validAccent(value: string | null): value is PronunciationAccent {
  return value === 'british' || value === 'american'
}

function readAccent(): PronunciationAccent {
  try {
    const value = globalThis.localStorage?.getItem(storageKey) ?? null
    return validAccent(value) ? value : defaultAccent
  } catch {
    return defaultAccent
  }
}

export const pronunciationAccent = ref<PronunciationAccent>(readAccent())

export function setPronunciationAccent(value: PronunciationAccent) {
  pronunciationAccent.value = value
  try { globalThis.localStorage?.setItem(storageKey, value) } catch { /* Keep the preference for this tab. */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return
    pronunciationAccent.value = validAccent(event.newValue) ? event.newValue : defaultAccent
  })
}
