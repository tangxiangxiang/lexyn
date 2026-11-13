export const cefrLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
export const wordbookOrders = ['alphabetical', 'bnc-common', 'bnc-rare', 'frq-common', 'frq-rare'] as const
export const wordbookStates = ['learned', 'unlearned', 'due'] as const

export interface WordbookFilters {
  cefr: (typeof cefrLevels[number] | 'unknown')[]
  collins: number[]
  states: typeof wordbookStates[number][]
  order: typeof wordbookOrders[number]
}

export const defaultWordbookFilters: WordbookFilters = {
  cefr: [], collins: [], states: [], order: 'alphabetical',
}

export interface VocabularySource {
  name: string
  url: string
  version: string
  importedAt?: string
  sha256: string
  license: string
  redistribution: 'with-attribution-and-share-alike' | 'verify-upstream-rights' | 'not-verified'
  fields: string[]
  wordCount: number
}

export interface WordClassification {
  source: string
  version: string
  cefr?: typeof cefrLevels[number]
  collins?: number
  oxfordCore?: boolean
  bncRank?: number
  frqRank?: number
  tags?: string[]
}

export interface WordbookSnapshot {
  id: string
  selection: string
  count: number
  sources: VocabularySource[]
}
