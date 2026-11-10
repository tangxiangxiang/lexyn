import type { DictionarySense, PhoneticVariants } from '../domain/dictionary.ts'

export const vocabularyTaskLimit = 1000
export const vocabularyLimits = { warning: 160, context: 240 }

export type VocabularyMode = 'meaning' | 'phonetics'
export type AccentPhonetics = Pick<PhoneticVariants, 'british' | 'american'>

export interface VocabularyCandidate {
  senses: DictionarySense[]
  phonetics: AccentPhonetics
  needsReview: boolean
  warning: string | null
}
export interface VocabularyTarget { entryId: string; revision: number }
export interface VocabularyJob {
  id: string
  deckId: string
  mode?: VocabularyMode
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  conflicts: number
  needsReview: number
  dictionarySaved?: number
  aiSaved?: number
  notFound?: number
  createdAt: number
  updatedAt: number
  error?: string
}
export interface VocabularyPlan {
  job: VocabularyJob | null
  missing: number
  missingPhonetics: number
  limit: number
  model: string
}
export interface VocabularyStatus {
  model: string
  status: 'missing' | 'unavailable' | 'unverified' | 'available' | 'auth' | 'quota'
}
