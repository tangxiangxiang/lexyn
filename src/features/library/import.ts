import Papa from 'papaparse'
import { cleanEntry, LibraryError, normalizeTerm, type Entry, type EntryInput } from '../../../shared/domain/library'

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const MAX_IMPORT_ROWS = 10_000
export const importFields = ['term', 'meaning', 'phonetic', 'example', 'note'] as const
export type ImportField = typeof importFields[number]
export type FieldMapping = Partial<Record<ImportField, number>>
export type TextMode = 'auto' | 'words' | 'tab'
export type DuplicateMode = 'skip' | 'overwrite'
export type ImportedInput = Pick<EntryInput, 'term'> & Partial<Omit<EntryInput, 'term'>>

interface SourceRow {
  number: number
  cells: string[]
}

export interface ImportSource {
  format: 'txt' | 'csv'
  headers: string[]
  rows: SourceRow[]
  textMode?: 'words' | 'tab'
}

export interface ImportCandidate {
  input: ImportedInput
  normalizedTerm: string
  match?: Pick<Entry, 'id' | 'revision'>
}

export interface ImportRow {
  number: number
  input?: ImportedInput
  issue?: string
  duplicate?: 'file' | 'existing'
}

export interface ImportPreview {
  rows: ImportRow[]
  candidates: ImportCandidate[]
  valid: number
  invalid: number
  duplicates: number
  missingMeaning: number
}

export async function readImportFile(file: File): Promise<{ format: ImportSource['format']; text: string }> {
  if (file.size > MAX_IMPORT_BYTES) throw new LibraryError('The file exceeds the 5 MiB limit.')
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (extension !== 'txt' && extension !== 'csv') throw new LibraryError('Choose a .txt or .csv file.')
  const bytes = await file.arrayBuffer()
  try {
    return { format: extension, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    throw new LibraryError('Save the file as UTF-8 and try again.')
  }
}

export function parseImport(text: string, format: ImportSource['format'], textMode: TextMode = 'auto'): ImportSource {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new LibraryError('The file exceeds the 5 MiB limit.')
  }
  const content = text.replace(/^\uFEFF/, '').replace(/(?:\r\n|\n|\r)$/, '')
  if (!content.trim()) throw new LibraryError('The file is empty.')

  if (format === 'csv') {
    const parsed = Papa.parse<string[]>(content, { delimiter: ',', preview: MAX_IMPORT_ROWS + 2 })
    const [headers, ...rows] = parsed.data
    if (rows.length > MAX_IMPORT_ROWS) throw new LibraryError('The file exceeds the 10,000 row limit.')
    if (parsed.errors.length) {
      const error = parsed.errors[0]
      throw new LibraryError(`Invalid CSV near record ${(error.row ?? 0) + 1}. Check the quotes and separators.`)
    }
    return { format, headers, rows: numberRows(rows, 2) }
  }

  const lines = content.split(/\r\n|\n|\r/, MAX_IMPORT_ROWS + 1)
  if (lines.length > MAX_IMPORT_ROWS) throw new LibraryError('The file exceeds the 10,000 row limit.')
  const mode = textMode === 'auto' ? (lines.some((line) => line.includes('\t')) ? 'tab' : 'words') : textMode
  const headers = mode === 'tab' ? ['term', 'meaning'] : ['term']
  const rows = lines.map((line) => mode === 'tab' ? line.split('\t') : [line])
  return { format, headers, rows: numberRows(rows, 1), textMode: mode }
}

function numberRows(rows: string[][], start: number) {
  return rows.map((cells, index) => ({ number: index + start, cells }))
    .filter(({ cells }) => cells.length !== 1 || cells[0].trim() !== '')
}

const aliases: Record<ImportField, string[]> = {
  term: ['term', 'word', 'english', '单词', '英文', '词汇'],
  meaning: ['meaning', 'definition', 'translation', 'chinese', '释义', '中文'],
  phonetic: ['phonetic', 'ipa', '音标'],
  example: ['example', 'sentence', '例句'],
  note: ['note', 'notes', '备注'],
}

export function suggestMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {}
  for (const field of importFields) {
    const index = headers.findIndex((header) => aliases[field].includes(normalizeTerm(header)))
    if (index !== -1) mapping[field] = index
  }
  return mapping
}

export function previewImport(source: ImportSource, mapping: FieldMapping, entries: Entry[]): ImportPreview {
  if (mapping.term === undefined || (source.format === 'csv' && mapping.meaning === undefined)) {
    throw new LibraryError('Map the Term and Meaning columns before previewing the CSV.')
  }
  const indices = Object.values(mapping)
  if (new Set(indices).size !== indices.length
    || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= source.headers.length)) {
    throw new LibraryError('Choose a different source column for each field.')
  }

  const active = new Map(entries.filter((entry) => entry.deletedAt === undefined)
    .map((entry) => [entry.normalizedTerm, entry]))
  const seen = new Set<string>()
  const preview: ImportPreview = { rows: [], candidates: [], valid: 0, invalid: 0, duplicates: 0, missingMeaning: 0 }
  for (const { number, cells } of source.rows) {
    try {
      if (source.format === 'csv' && cells.length !== source.headers.length) {
        throw new LibraryError('The column count differs from the header.')
      }
      if (source.format === 'txt' && cells.length > source.headers.length) {
        throw new LibraryError('Use one tab between the term and meaning.')
      }
      const values: Partial<EntryInput> = {}
      for (const field of importFields) {
        const index = mapping[field]
        if (index !== undefined && cells[index] !== undefined) values[field] = cells[index]
      }
      const cleaned = cleanEntry({ ...values, term: values.term ?? '', meaning: values.meaning ?? '' })
      const input: ImportedInput = { term: cleaned.term }
      for (const field of importFields) {
        if (field !== 'term' && values[field] !== undefined) input[field] = cleaned[field] ?? ''
      }
      const normalizedTerm = normalizeTerm(input.term)
      const existing = active.get(normalizedTerm)
      const duplicate = seen.has(normalizedTerm) ? 'file' : existing ? 'existing' : undefined
      preview.rows.push({ number, input, duplicate })
      preview.valid++
      if (duplicate) preview.duplicates++
      if (!cleaned.meaning) preview.missingMeaning++
      if (duplicate === 'file') continue
      seen.add(normalizedTerm)
      preview.candidates.push({ input, normalizedTerm, match: existing && { id: existing.id, revision: existing.revision } })
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error
      preview.rows.push({ number, issue: error.message })
      preview.invalid++
    }
  }
  return preview
}
