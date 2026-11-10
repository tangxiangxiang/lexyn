export const vocabularyTaskLimit = 1000
export const vocabularyLimits = { meaning: 80, explanation: 200, example: 240, warning: 160, context: 240 }

export interface VocabularyFields {
  meaning: string
  explanation: string
  example: string
}
export interface VocabularyCandidate extends VocabularyFields {
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
