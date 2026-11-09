import { computed, inject, onMounted, onUnmounted, provide, ref, type InjectionKey } from 'vue'
import { readAppearance, writeAppearance, type Appearance } from '../db/local'

function createAppearance() {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(media.matches)
  const appearance = ref<Appearance>('system')
  const busy = ref(true)
  const error = ref('')
  const dark = computed(() => appearance.value === 'dark'
    || (appearance.value === 'system' && systemDark.value))

  function updateSystem(event: MediaQueryListEvent) {
    systemDark.value = event.matches
  }

  onMounted(async () => {
    media.addEventListener('change', updateSystem)
    try {
      appearance.value = await readAppearance()
    } catch {
      error.value = 'Could not read your device preferences.'
    } finally {
      busy.value = false
    }
  })
  onUnmounted(() => media.removeEventListener('change', updateSystem))

  async function setAppearance(value: Appearance) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      await writeAppearance(value)
      appearance.value = value
    } catch {
      error.value = 'Could not save your theme on this device. Try again.'
    } finally {
      busy.value = false
    }
  }

  return { appearance, busy, dark, error, setAppearance }
}

const appearanceKey: InjectionKey<ReturnType<typeof createAppearance>> = Symbol('appearance')

export function provideAppearance() {
  const appearance = createAppearance()
  provide(appearanceKey, appearance)
  return appearance
}

export function useAppearance() {
  const appearance = inject(appearanceKey)
  if (!appearance) throw new Error('Appearance provider is missing.')
  return appearance
}
