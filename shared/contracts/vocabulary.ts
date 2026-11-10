import type { DictionarySense } from '../domain/dictionary.ts'

export const vocabularyTaskLimit = 1000
export const vocabularyLimits = { warning: 160, context: 240 }

export interface VocabularyCandidate {
  senses: DictionarySense[]
  needsReview: boolean
  warning: string | null
}
export interface VocabularyTarget { entryId: string; revision: number }
export interface VocabularyJob {
  id: string
  deckId: string
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
  limit: number
  model: string
}
export interface VocabularyStatus {
  model: string
  status: 'missing' | 'unavailable' | 'unverified' | 'available' | 'auth' | 'quota'
}
