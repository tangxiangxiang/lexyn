import { study } from '../../api/client'
import type { StudyEndpoints } from '../../../shared/contracts/study'

export const library = {
  async listDecks(signal?: AbortSignal) {
    const decks: StudyEndpoints['library/decks']['result'] = []
    for (let offset = 0; ; offset += 200) {
      const page = await study('library/decks', [offset, 200], { signal })
      decks.push(...page)
      if (page.length < 200) return decks
    }
  },
  getLists: (deckId: string, signal?: AbortSignal) => study('library/lists', [deckId], { signal }),
  getList: (args: StudyEndpoints['library/list']['args'], signal?: AbortSignal) => study('library/list', args, { signal }),
  renameList: (...args: StudyEndpoints['library/rename-list']['args']) => study('library/rename-list', args, { write: true }),
  getDeck: (args: StudyEndpoints['library/deck']['args'], signal?: AbortSignal) => study('library/deck', args, { signal }),
  createDeck: (...args: StudyEndpoints['library/create-deck']['args']) => study('library/create-deck', args, { write: true }),
  updateDeck: (...args: StudyEndpoints['library/update-deck']['args']) => study('library/update-deck', args, { write: true }),
  setDeckArchived: (...args: StudyEndpoints['library/archive-deck']['args']) => study('library/archive-deck', args, { write: true }),
  createEntry: (...args: StudyEndpoints['library/create-entry']['args']) => study('library/create-entry', args, { write: true }),
  updateEntry: (...args: StudyEndpoints['library/update-entry']['args']) => study('library/update-entry', args, { write: true }),
  setEntryRemoved: (...args: StudyEndpoints['library/remove-entry']['args']) => study('library/remove-entry', args, { write: true }),
  previewImport: (args: StudyEndpoints['library/import-preview']['args'], signal?: AbortSignal) =>
    study('library/import-preview', args, { signal, post: true }),
  importEntries: (...args: StudyEndpoints['library/import']['args']) => study('library/import', args, { write: true }),
  exportLibrary: (deckId?: string) => study('backup/library', [deckId]),
}
