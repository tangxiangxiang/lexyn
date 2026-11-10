import { computed, onMounted, onUnmounted, watch, type WatchSource } from 'vue'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { review } from './api'
import { useI18n } from '../../i18n/useI18n'
import { study } from '../../api/client'

const refreshLimit = 30 * 60 * 1000
const { languageTag } = useI18n()
const timeFormat = computed(() => new Intl.DateTimeFormat(languageTag.value, { dateStyle: 'medium', timeStyle: 'short' }))

export const formatReviewTime = (timestamp: number) => timeFormat.value.format(timestamp)

export function useReviewOverview(deckId: WatchSource<string | undefined>, progress = false) {
  const overview = useLibraryQuery(deckId, (id, signal) => progress ? study('progress/overview', [], { signal }) : review.overview(id, signal))
  watch(overview.data, (data, _, onCleanup) => {
    if (!data) return
    const now = data.checkedAt
    const next = Math.min(data.nextDueAt ?? Infinity, data.nextDayAt, now + refreshLimit)
    const timer = window.setTimeout(overview.reload, Math.max(1000, next - now))
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
