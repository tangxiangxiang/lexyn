import type { StudyEndpoints } from '../../../shared/contracts/study'
import { isUuid } from '../../../shared/contracts/validation'
import { session } from '../../api/client'

type WordArgs = StudyEndpoints['library/words']['args']
export type Playlist = { filter: WordArgs[3]; sort: WordArgs[4]; count: number; position: number }
export type ListeningBookmark = Pick<Playlist, 'filter' | 'sort'> & { entryId: string }

function key(deckId: string) {
  return session.value ? `lexyn.listening.${session.value.ownerId}.${deckId}` : undefined
}

export function readListeningBookmark(deckId: string): ListeningBookmark | undefined {
  const storageKey = key(deckId)
  if (!storageKey) return
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (value && isUuid(value.entryId)
      && ['all', 'learned', 'unlearned', 'today', 'week'].includes(value.filter)
      && ['added', 'learned', 'alphabetical'].includes(value.sort)) return value
  } catch { /* The player can run without a saved position. */ }
}

export function saveListeningBookmark(deckId: string, bookmark: ListeningBookmark) {
  const storageKey = key(deckId)
  if (!storageKey) return
  try { localStorage.setItem(storageKey, JSON.stringify(bookmark)) }
  catch { /* Playback remains available when browser storage is disabled. */ }
}
