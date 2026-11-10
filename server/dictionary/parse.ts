import { cleanDictionaryMeaning, dictionaryLimits, type DictionaryMeaning, type DictionarySense } from '../../shared/domain/dictionary.ts'

const partOfSpeech = /^([a-z][a-z./-]{0,21}\.)\s+/i
const domain = /^\[([\p{Script=Han}A-Za-z]{1,8})\]\s*/u
const pairs: Record<string, string> = { '(': ')', '（': '）', '[': ']', '【': '】', '「': '」',
  '『': '』', '《': '》', '“': '”', '"': '"' }
const closing = new Set(Object.values(pairs))

/** The standard ECDICT list delimiter is comma + whitespace. Preserve semicolon
 * clauses and punctuation inside glosses, quotes and examples verbatim. */
function definitionsIn(gloss: string): string[] | undefined {
  const stack: string[] = []
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < gloss.length; i++) {
    const char = gloss[i]
    if (char === stack.at(-1)) stack.pop()
    else if (pairs[char]) stack.push(pairs[char])
    else if (closing.has(char)) return
    else if (!stack.length && char === ',' && /\s/.test(gloss[i + 1] ?? '')) {
      parts.push(gloss.slice(start, i).trim())
      start = i + 1
    }
  }
  if (stack.length) return
  parts.push(gloss.slice(start).trim())
  if (parts.some((part) => !part)) return
  // Clause punctuation can indicate prose rather than a list.
  return /[；;。:：]/.test(gloss) ? [gloss] : parts
}

export function parseDictionaryMeaning(sourceWord: string, rawTranslation: string, sourceRevision?: string): DictionaryMeaning | undefined {
  if (!rawTranslation.trim()) return
  const metadata = { sourceWord, sourceRevision, rawTranslation }
  const senses: DictionarySense[] = []
  const seen = new Set<string>()
  let partial = false
  for (const rawLine of rawTranslation.split(/\\n|\r\n|\n|\r/)) {
    let gloss = rawLine.trim()
    if (!gloss) continue
    const pos = partOfSpeech.exec(gloss)?.[1] ?? ''
    gloss = gloss.slice(pos.length).trim()
    const label = domain.exec(gloss)
    if (label) gloss = gloss.slice(label[0].length).trim()
    const parsed = definitionsIn(gloss)
    if (!parsed || (!pos && !label) || /(?:\s|[;；])[a-z]{1,8}\.\s*\p{Script=Han}/iu.test(gloss)) partial = true
    // Keep unknown lines intact as unlabelled groups. Raw fallback is always available.
    const definitions = (parsed && (pos || label) ? parsed : [gloss]).filter((text) => {
      const key = JSON.stringify([pos, label?.[1], text])
      if (!text || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!definitions.length) { if (!gloss) partial = true; continue }
    const sense: DictionarySense = { partOfSpeech: pos, domain: label?.[1], definitions, source: 'ecdict' }
    try {
      cleanDictionaryMeaning({ ...metadata, senses: [...senses, sense] })
      senses.push(sense)
    } catch { partial = true }
  }
  return { ...metadata, senses, ...(partial || !senses.length ? { partiallyStructured: true } : {}) }
}
