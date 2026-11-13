import type { WordbookFilters } from '../../shared/contracts/wordbooks.ts'
import type { BuiltinWordbookId, BuiltinWordbookTag } from '../../shared/domain/builtin-books.ts'
import type { ReviewSchedulerConfig } from '../../shared/domain/review.ts'
import type { Ecdict } from '../dictionary/ecdict.ts'
import { emptyWordbook, type WordState } from '../dictionary/wordbooks.ts'
import { createLibraryService } from './library.ts'
import { StudyError, type StudyStore } from './store.ts'

function wordStates(store: StudyStore, now: number) {
  return store.db.prepare(`
    SELECT w.normalized_term AS normalizedTerm, w.variant, p.word_id IS NOT NULL AS learned,
      coalesce(json_extract(c.body, '$.dueAt')<=?,0) AS due
    FROM words w LEFT JOIN word_progress p ON p.word_id=w.id
      LEFT JOIN word_cards link ON link.word_id=w.id AND link.active=1
      LEFT JOIN review_cards c ON c.id=link.card_id
    WHERE w.language='en' AND (p.word_id IS NOT NULL OR c.id IS NOT NULL)
  `).all(now) as WordState[]
}

export function previewBuiltinBook(store: StudyStore, dictionary: Ecdict | undefined, now: number, id: BuiltinWordbookId,
  selectedTags: BuiltinWordbookTag[], filters: WordbookFilters, offset: number, limit: number) {
  const result = dictionary?.wordbook(id, { selectedTags, filters, offset, limit }, wordStates(store, now))
  if (!result) return { ...emptyWordbook(selectedTags), installed: false, cefrAvailable: false, cefrLevels: [] }
  const { rows: _rows, ...preview } = result
  return preview
}

export function installBuiltinBook(store: StudyStore, config: ReviewSchedulerConfig, dictionary: Ecdict | undefined, now: number,
  id: BuiltinWordbookId, selectedTags: BuiltinWordbookTag[], filters: WordbookFilters, size: number, selection: string) {
  const library = createLibraryService(store, config)
  const previous = library.installedBuiltinBook(id, now)
  if (previous) return previous
  const result = dictionary?.wordbook(id, { selectedTags, filters, offset: 0, limit: 0 }, wordStates(store, now), true)
  if (!result?.installed) throw new StudyError('ECDICT is not installed on this server.', 404)
  if (selection !== result.selection) throw new StudyError('The wordbook preview changed. Refresh and confirm again.', 409)
  if (!result.rows.length) throw new StudyError('No words match the selected word groups.', 404)
  return library.createBuiltinBook(id, result.rows, now, size, { id, selection, count: result.count, sources: result.sources })
}
