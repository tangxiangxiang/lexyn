import type { VocabularyCandidate, VocabularyJob, VocabularyPlan, VocabularyStatus,
  VocabularyTarget } from '../../../shared/contracts/vocabulary'
import { ownerFeatureRequest } from '../../api/client'

const path = (deckId: string) => 'vocabulary/batch/' + encodeURIComponent(deckId)

export const vocabulary = {
  status: (signal?: AbortSignal) => ownerFeatureRequest<VocabularyStatus>('vocabulary/status', 'GET', undefined, signal),
  generate: (input: { deckId: string; term: string; hint?: string } & Partial<VocabularyTarget>, signal: AbortSignal) =>
    ownerFeatureRequest<VocabularyCandidate>('vocabulary/candidate', 'POST', input, signal, 32_000),
  plan: (deckId: string, signal?: AbortSignal) => ownerFeatureRequest<VocabularyPlan>(path(deckId), 'GET', undefined, signal),
  start: (deckId: string, input: { count: number; requestId: string; afterTaskId: string | null }) =>
    ownerFeatureRequest<VocabularyJob>(path(deckId), 'POST', input),
  cancel: (deckId: string, jobId: string) =>
    ownerFeatureRequest<VocabularyJob>(path(deckId) + '/cancel', 'POST', { jobId }),
}
