import { liveQuery } from 'dexie'
import { onScopeDispose, ref, shallowRef, watch, type WatchSource } from 'vue'

export function useLibraryQuery<K, T>(source: WatchSource<K>, query: (key: K) => Promise<T>) {
  const data = shallowRef<T>()
  const error = ref(false)
  const retry = ref(0)
  const stop = watch([source, retry], ([key], _, onCleanup) => {
    data.value = undefined
    error.value = false
    const subscription = liveQuery(() => query(key)).subscribe({
      next: (value) => { data.value = value },
      error: () => { error.value = true },
    })
    onCleanup(() => subscription.unsubscribe())
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(stop)
  return { data, error, reload: () => retry.value++ }
}
