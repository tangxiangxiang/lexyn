export interface DictionaryEntry {
  word: string
  phonetic: string
  translation: string
  definition: string
  pos: string
  tag: string
}
export interface DictionaryLookup {
  query: string
  found: boolean
  match: 'exact' | 'casefold' | 'none'
  entries: DictionaryEntry[]
  suggestedMeaning?: string
  needsReview: boolean
}
export interface DictionaryStatus {
  installed: boolean
  wordCount: number
  source?: string
  sourceCommit?: string
  csvSha256?: string
  error?: string
}
