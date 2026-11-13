import { computed, onMounted, onUnmounted, watch, type WatchSource } from 'vue'
import { useLibraryQuery } from '../library/useLibraryQuery'
import { review } from './api'
import { useI18n } from '../../i18n/useI18n'
import type { StudyEndpoints } from '../../../shared/contracts/study'
import { study } from '../../api/client'

const refreshLimit = 30 * 60 * 1000
const { languageTag } = useI18n()
const timeFormat = computed(() => new Intl.DateTimeFormat(languageTag.value, { dateStyle: 'medium', timeStyle: 'short' }))

export const formatReviewTime = (timestamp: number) => timeFormat.value.format(timestamp)

export function useReviewOverview<P extends boolean = false>(deckId: WatchSource<string | undefined>, progress = false as P, listId: WatchSource<string | undefined> = () => undefined) {
  const scope = computed(() => [typeof deckId === 'function' ? deckId() : deckId.value,
    typeof listId === 'function' ? listId() : listId.value] as const)
  type Data = P extends true ? StudyEndpoints['progress/overview']['result'] : StudyEndpoints['review/overview']['result']
  const overview = useLibraryQuery(scope, ([id, list], signal) =>
    (progress ? study('progress/overview', [], { signal }) : review.overview(id, signal, list)) as Promise<Data>,
    ([id, list]) => [id, list].join('/'))
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
