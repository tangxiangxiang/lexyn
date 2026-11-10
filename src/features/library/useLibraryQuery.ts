import { onScopeDispose, ref, shallowRef, watch, type WatchSource } from 'vue'
import { onStudyChange } from '../../api/client'

export function useLibraryQuery<K, T>(source: WatchSource<K>, query: (key: K, signal: AbortSignal) => Promise<T>, scope: (key: K) => unknown = (key) => key) {
  const data = shallowRef<T>()
  const error = ref('')
  let active: AbortController | undefined
  let load: (() => Promise<void>) | undefined
  const stop = watch(source, (key, previous, onCleanup) => {
    // Preserve the current view during refreshes. Never show another deck or session's data.
    if (previous === undefined || scope(key) !== scope(previous)) data.value = undefined
    load = async () => {
      active?.abort()
      const current = active = new AbortController()
      try {
        const result = await query(key, current.signal)
        if (!current.signal.aborted) {
          data.value = result
          error.value = ''
        }
      } catch (cause) {
        if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load server data.'
      }
    }
    void load()
    onCleanup(() => active?.abort())
  }, { immediate: true })
  const reload = async () => { await load?.() }
  const unsubscribe = onStudyChange(reload)
  onScopeDispose(() => { unsubscribe(); stop() })
  return { data, error, reload }
}
