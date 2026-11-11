import { ref } from 'vue'
import { library } from './api'
import { t } from '../../i18n/useI18n'

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
      error.value = cause instanceof Error ? cause.message : 'The request failed. Try again.'
    } finally {
      busy.value = false
    }
  }
  return { busy, error, run }
}

export async function downloadLibrary(deckId?: string) {
  const snapshot = await library.exportLibrary(deckId)
  downloadJson(snapshot, `lexyn-${deckId ? 'deck' : 'library'}-${snapshot.exportedAt.slice(0, 10)}.json`)
}

export function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const wordCount = (count: number) => t(count === 1 ? '{count} word' : '{count} words', { count })

export function closeLibraryMenu(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button')) {
    (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
  }
}
