export interface DictionarySense {
  partOfSpeech: string
  definitions: string[]
  domain?: string
  source: 'ecdict' | 'ai' | 'manual'
}

export interface PhoneticVariants {
  british?: string
  american?: string
  unspecified?: string
}

export interface DictionaryMeaning {
  /** Legacy source snapshot fields are accepted for existing local records. New entries store the snapshot on Entry.dictionaryReference. */
  sourceWord?: string
  sourceRevision?: string
  rawTranslation?: string
  /** The structured groups cannot represent all of the original formatting/content. */
  partiallyStructured?: true
  model?: string
  promptVersion?: string
  optimizedAt?: number
  senses: DictionarySense[]
}

export interface DictionaryReference {
  sourceWord: string
  sourceRevision?: string
  translation: string
  definition: string
  partOfSpeech: string
  phonetic: string
}

export const dictionaryLimits = { rawTranslation: 20_000, senses: 64, definitions: 40, definition: 1000,
  partOfSpeech: 24, domain: 64, sourceWord: 240, sourceRevision: 128, structuredText: 40_000,
  phonetic: 240, model: 80, promptVersion: 40 }

export function meaningFromSenses(senses: DictionarySense[]) {
  const groups = new Map<string, { partOfSpeech: string; domain?: string; definitions: string[] }>()
  for (const sense of senses) {
    const key = JSON.stringify([sense.partOfSpeech.trim(), sense.domain?.trim() || ''])
    let group = groups.get(key)
    if (!group) {
      group = { partOfSpeech: sense.partOfSpeech.trim(), domain: sense.domain?.trim() || undefined, definitions: [] }
      groups.set(key, group)
    }
    for (const definition of sense.definitions) {
      const text = definition.trim()
      if (text && !group.definitions.includes(text)) group.definitions.push(text)
    }
  }
  return [...groups.values()].filter(({ definitions }) => definitions.length)
    .map(({ partOfSpeech, domain, definitions }) =>
      `${partOfSpeech ? `${partOfSpeech} ` : ''}${domain ? `[${domain}] ` : ''}${definitions.join('；')}`)
    .join('\n')
}

export function hasFinalMeaning(value: DictionaryMeaning | undefined) {
  return !!value?.senses.some((sense) => sense.source !== 'ecdict'
    && sense.definitions.some((definition) => definition.trim()))
}

export function phoneticText(value: PhoneticVariants | undefined, legacy?: string) {
  if (value?.british || value?.american) return [value.british && `英 ${value.british}`, value.american && `美 ${value.american}`].filter(Boolean).join(' · ')
  return value?.unspecified || legacy || ''
}

export function formatPhonetic(value?: string) {
  const text = value?.trim().replace(/^\/+|\/+$/g, '').trim()
  return text ? `/${text}/` : ''
}

export function cleanPhonetics(value: unknown): PhoneticVariants | undefined {
  if (value === undefined || value === null) return
  const row = record(value, 'british american unspecified')
  const result: PhoneticVariants = {}
  for (const key of ['british', 'american', 'unspecified'] as const) {
    const text = row[key]
    if (text !== undefined) result[key] = line(text, dictionaryLimits.phonetic)
  }
  return Object.values(result).some(Boolean) ? result : undefined
}

export function cleanDictionaryReference(value: unknown): DictionaryReference | undefined {
  if (value === undefined || value === null) return
  const row = record(value, 'sourceWord sourceRevision translation definition partOfSpeech phonetic')
  const sourceWord = line(row.sourceWord, dictionaryLimits.sourceWord)
  const sourceRevision = row.sourceRevision === undefined ? undefined : line(row.sourceRevision, dictionaryLimits.sourceRevision)
  const raw = (key: 'translation' | 'definition' | 'partOfSpeech') => {
    const field = row[key]
    if (typeof field !== 'string' || field.length > dictionaryLimits.rawTranslation
      || /\p{Cc}/u.test(key === 'partOfSpeech' ? field : field.replace(/[\r\n\t]/g, ''))) return invalid()
    return field
  }
  const phonetic = row.phonetic
  if (typeof phonetic !== 'string' || phonetic.length > dictionaryLimits.phonetic || /\p{Cc}/u.test(phonetic)) return invalid()
  return { sourceWord, sourceRevision, translation: raw('translation'), definition: raw('definition'),
    partOfSpeech: raw('partOfSpeech'), phonetic }
}

const invalid = (): never => { throw new Error('Invalid dictionary meaning.') }

function record(value: unknown, keys: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !keys.split(' ').includes(key))) return invalid()
  return row
}

function line(value: unknown, max: number, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || /\p{Cc}/u.test(value)) return invalid()
  const text = value.trim()
  return text || (allowEmpty ? '' : invalid())
}

export function cleanDictionaryMeaning(value: unknown): DictionaryMeaning | undefined {
  if (value === undefined || value === null) return
  const row = record(value, 'sourceWord sourceRevision rawTranslation partiallyStructured model promptVersion optimizedAt senses')
  const sourceWord = row.sourceWord === undefined ? undefined : line(row.sourceWord, dictionaryLimits.sourceWord)
  const sourceRevision = row.sourceRevision === undefined ? undefined : line(row.sourceRevision, dictionaryLimits.sourceRevision)
  const raw = row.rawTranslation
  if (raw !== undefined && (typeof raw !== 'string' || !raw.trim() || raw.length > dictionaryLimits.rawTranslation)) return invalid()
  if ((raw !== undefined) !== !!sourceWord || (sourceRevision !== undefined && !sourceWord)
    || (row.partiallyStructured !== undefined && (row.partiallyStructured !== true || raw === undefined))) return invalid()
  const model = row.model === undefined ? undefined : line(row.model, dictionaryLimits.model)
  const promptVersion = row.promptVersion === undefined ? undefined : line(row.promptVersion, dictionaryLimits.promptVersion)
  const optimizedAt = row.optimizedAt
  if (optimizedAt !== undefined && (typeof optimizedAt !== 'number' || !Number.isSafeInteger(optimizedAt) || optimizedAt < 0)) return invalid()
  if (!Array.isArray(row.senses) || row.senses.length > dictionaryLimits.senses) return invalid()
  let length = 0
  const senses = row.senses.map((value): DictionarySense => {
    const sense = record(value, 'partOfSpeech definitions domain source')
    const { source } = sense
    if (source !== 'ai' && source !== 'manual' && (source !== 'ecdict' || !sourceWord)) return invalid()
    const partOfSpeech = line(sense.partOfSpeech, dictionaryLimits.partOfSpeech, true)
    const domain = sense.domain === undefined ? undefined : line(sense.domain, dictionaryLimits.domain)
    if (!Array.isArray(sense.definitions) || !sense.definitions.length || sense.definitions.length > dictionaryLimits.definitions) return invalid()
    const definitions = sense.definitions.map((definition) => line(definition, dictionaryLimits.definition))
    length += partOfSpeech.length + (domain?.length ?? 0) + definitions.reduce((sum, text) => sum + text.length, 0)
    if (length > dictionaryLimits.structuredText) return invalid()
    return { partOfSpeech, definitions, domain, source }
  })
  if (raw === undefined && !senses.length) return
  return { sourceWord, sourceRevision, rawTranslation: raw, partiallyStructured: row.partiallyStructured,
    model, promptVersion, optimizedAt, senses }
}

/** Preserve all saved dictionary/manual groups and append only new AI definitions. */
export function addAiSenses(current: DictionaryMeaning | undefined, incoming: DictionarySense[]) {
  const previousCount = current?.senses.length ?? 0
  if (!incoming.length) return current
  const senses = current?.senses.slice() ?? []
  for (const sense of incoming) {
    const existing = new Set(senses.filter((row) => row.partOfSpeech === sense.partOfSpeech
      && row.domain === sense.domain).flatMap((row) => row.definitions))
    const definitions = sense.definitions.filter((text) => !existing.has(text))
    if (!definitions.length) continue
    try {
      cleanDictionaryMeaning({ ...current, senses: [...senses, { ...sense, definitions }] })
    } catch { break } // Existing dictionary/manual content takes precedence at the storage limit.
    senses.push({ ...sense, definitions })
  }
  return senses.length !== previousCount ? { ...current, senses } : current
}
