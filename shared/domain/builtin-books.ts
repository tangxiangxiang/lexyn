export const builtinWordbooks = [
  { id: 'elementary', name: 'Primary school', tag: undefined },
  { id: 'junior-high', name: 'Junior high', tag: undefined },
  { id: 'zhongkao', name: 'Junior high entrance exam', tag: 'zk' },
  { id: 'senior-high', name: 'Senior high', tag: undefined },
  { id: 'gaokao', name: 'College entrance exam', tag: 'gk' },
  { id: 'cet4', name: 'College English Test Band 4', tag: 'cet4' },
  { id: 'cet6', name: 'College English Test Band 6', tag: 'cet6' },
  { id: 'postgraduate', name: 'Postgraduate entrance exam', tag: 'ky' },
  { id: 'ielts', name: 'IELTS', tag: 'ielts' },
  { id: 'toefl', name: 'TOEFL', tag: 'toefl' },
] as const

export type BuiltinWordbookId = typeof builtinWordbooks[number]['id']
export type BuiltinWordbookDefinition = typeof builtinWordbooks[number]

export const builtinWordbookTags = [
  { id: 'zk', name: 'Junior high entrance exam' },
  { id: 'gk', name: 'College entrance exam' },
  { id: 'cet4', name: 'College English Test Band 4' },
  { id: 'cet6', name: 'College English Test Band 6' },
  { id: 'ky', name: 'Postgraduate entrance exam' },
  { id: 'ielts', name: 'IELTS' },
  { id: 'toefl', name: 'TOEFL' },
] as const

export type BuiltinWordbookTag = typeof builtinWordbookTags[number]['id']

export const builtinWordbookById = Object.fromEntries(builtinWordbooks.map((book) => [book.id, book])) as
  Record<BuiltinWordbookId, BuiltinWordbookDefinition>

export const builtinWordbookDescription = (id: BuiltinWordbookId) => `Built-in ECDICT wordbook · ${id}`

export const wordbookLanguages = [
  { id: 'en', label: 'English', available: true },
  { id: 'ja', label: 'Japanese', available: false },
  { id: 'ko', label: 'Korean', available: false },
  { id: 'de', label: 'German', available: false },
  { id: 'fr', label: 'French', available: false },
  { id: 'es', label: 'Spanish', available: false },
  { id: 'pt', label: 'Portuguese', available: false },
  { id: 'it', label: 'Italian', available: false },
] as const
