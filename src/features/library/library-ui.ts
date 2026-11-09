import { ref } from 'vue'
import { LibraryError } from '../../../shared/domain/library'
import { library } from './repository'

export function useLibraryAction() {
  const busy = ref(false)
  const error = ref('')
  async function run<T>(action: () => Promise<T>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      return await action()
    } catch (cause) {
      error.value = cause instanceof LibraryError ? cause.message : 'Lexyn could not access this browser’s storage. Try again.'
    } finally {
      busy.value = false
    }
  }
  return { busy, error, run }
}

export async function downloadLibrary(deckId?: string) {
  const snapshot = await library.exportLibrary(deckId)
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `lexyn-${deckId ? 'deck' : 'library'}-${snapshot.exportedAt.slice(0, 10)}.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
export const formatModified = (time: number) => dateFormatter.format(time)
export const wordCount = (count: number) => `${count} ${count === 1 ? 'word' : 'words'}`
