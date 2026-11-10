import type { VocabularyJob, VocabularyMode, VocabularyPlan, VocabularyStatus } from '../../../shared/contracts/vocabulary'
import type { Entry } from '../../../shared/domain/library'
import { ownerFeatureRequest } from '../../api/client'

const path = (deckId: string) => 'vocabulary/batch/' + encodeURIComponent(deckId)

export const vocabulary = {
  status: (signal?: AbortSignal) => ownerFeatureRequest<VocabularyStatus>('vocabulary/status', 'GET', undefined, signal),
  optimize: (input: { entryId: string; revision: number; hint?: string }, signal?: AbortSignal) =>
    ownerFeatureRequest<Entry>(`vocabulary/optimize/${encodeURIComponent(input.entryId)}`,
      'POST', { revision: input.revision, hint: input.hint }, signal, 60_000),
  async auto(entryId: string, revision: number) {
    const path = `vocabulary/auto/${encodeURIComponent(entryId)}`
    const started = await ownerFeatureRequest<{ started: boolean; ready: boolean }>(path, 'POST', { revision }, undefined, 10_000)
    if (started.ready || !started.started) return
    for (let attempt = 0; attempt < 28; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const state = await ownerFeatureRequest<{ status: 'running' | 'idle' | 'completed' | 'failed'; error?: string }>(
        `${path}?revision=${revision}`, 'GET', undefined, undefined, 10_000)
      if (state.status === 'completed') return
      if (state.status === 'failed') throw new Error(state.error ?? 'Vocabulary generation failed.')
    }
    throw new Error('Vocabulary generation is still running. Refresh later to see the saved meaning.')
  },
  plan: (deckId: string, signal?: AbortSignal) => ownerFeatureRequest<VocabularyPlan>(path(deckId), 'GET', undefined, signal),
  start: (deckId: string, input: { count: number; requestId: string; afterTaskId: string | null; mode: VocabularyMode }) =>
    ownerFeatureRequest<VocabularyJob>(path(deckId), 'POST', input),
  cancel: (deckId: string, jobId: string) =>
    ownerFeatureRequest<VocabularyJob>(path(deckId) + '/cancel', 'POST', { jobId }),
}
