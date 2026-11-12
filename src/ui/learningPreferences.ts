import { ref } from 'vue'
import type { LearnMode } from '../../shared/domain/learning'

export type LearningPreferences = {
  defaultMode: LearnMode
  hidePhonetics: boolean
}

const storageKey = 'lexyn.learningPreferences'
const defaults: LearningPreferences = { defaultMode: 'copy', hidePhonetics: false }

function readPreferences(): LearningPreferences {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? 'null')
    if (!value || typeof value !== 'object') return defaults
    const record = value as Record<string, unknown>
    return {
      defaultMode: record.defaultMode === 'dictation' ? 'dictation' : 'copy',
      hidePhonetics: record.hidePhonetics === true,
    }
  } catch {
    return defaults
  }
}

export const learningPreferences = ref(readPreferences())

function save() {
  try { globalThis.localStorage?.setItem(storageKey, JSON.stringify(learningPreferences.value)) }
  catch { /* Keep the selected preference for the current page. */ }
}

export function setDefaultLearnMode(mode: LearnMode) {
  learningPreferences.value.defaultMode = mode
  save()
}

export function setHidePhonetics(value: boolean) {
  learningPreferences.value.hidePhonetics = value
  save()
}
