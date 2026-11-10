import type { DictionaryLookup, DictionaryStatus } from '../../../shared/contracts/dictionary'
import { ownerFeatureRequest } from '../../api/client'

export const dictionary = {
  status: (signal?: AbortSignal) => ownerFeatureRequest<DictionaryStatus>('dictionary/status', 'GET', undefined, signal),
  lookup: (term: string, signal?: AbortSignal) =>
    ownerFeatureRequest<DictionaryLookup>('dictionary/lookup', 'POST', { term }, signal),
  lookupBatch: (terms: string[], signal?: AbortSignal) =>
    ownerFeatureRequest<DictionaryLookup[]>('dictionary/lookup-batch', 'POST', { terms }, signal),
}
