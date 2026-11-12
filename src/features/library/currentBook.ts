import { session } from '../../api/client'

function storageKey() {
  return session.value ? `lexyn.currentBook.${session.value.ownerId}` : undefined
}

export function currentBookId() {
  const key = storageKey()
  if (!key) return undefined
  try { return localStorage.getItem(key) ?? undefined }
  catch { return undefined }
}

export function rememberCurrentBook(deckId: string) {
  const key = storageKey()
  if (!key) return
  try { localStorage.setItem(key, deckId) }
  catch { /* The reader still opens when browser storage is unavailable. */ }
}

export function clearCurrentBook() {
  const key = storageKey()
  if (!key) return
  try { localStorage.removeItem(key) }
  catch { /* The archived book remains available in the library. */ }
}
