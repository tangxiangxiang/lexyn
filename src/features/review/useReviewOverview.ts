import { onMounted, onUnmounted, watch, type WatchSource } from 'vue'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { localDayBounds, review } from './repository'

const refreshLimit = 30 * 60 * 1000
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export const formatReviewTime = (timestamp: number) => timeFormat.format(timestamp)

export function useReviewOverview(deckId: WatchSource<string | undefined>) {
  const overview = useLibraryQuery(deckId, (id) => review.overview(id))
  watch(overview.data, (data, _, onCleanup) => {
    if (!data) return
    const now = Date.now()
    const [, midnight] = localDayBounds(now)
    const next = Math.min(data.nextDueAt ?? Infinity, midnight, now + refreshLimit)
    const timer = window.setTimeout(overview.reload, Math.max(0, next - now))
    onCleanup(() => window.clearTimeout(timer))
  })

  function refreshWhenVisible() {
    if (document.visibilityState === 'visible') overview.reload()
  }

  onMounted(() => {
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
  })
  onUnmounted(() => {
    window.removeEventListener('focus', refreshWhenVisible)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  })
  return overview
}
