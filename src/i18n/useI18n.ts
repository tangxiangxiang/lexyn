import { computed, ref, watch } from 'vue'
import { zh } from './messages'

export type Locale = 'zh' | 'en'
const storageKey = 'lexyn.locale'
const defaultLocale: Locale = 'zh'

function readLocale(): Locale {
  try { return globalThis.localStorage?.getItem(storageKey) === 'en' ? 'en' : defaultLocale }
  catch { return defaultLocale }
}

// Nuvyn's shared reactive locale and placeholder lookup, with a local browser preference.
const current = ref<Locale>(readLocale())
const locale = computed(() => current.value)
const languageTag = computed(() => current.value === 'zh' ? 'zh-CN' : 'en')

export function t(key: string, params: Record<string, string | number> = {}, language: Locale = current.value): string {
  const value = language === 'zh' && Object.hasOwn(zh, key) ? zh[key] : key
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match)
}

export function translateError(message: string): string {
  if (locale.value !== 'zh') return message
  const limit = /^(.+) must be at most (\d+) characters\.$/.exec(message)
  if (limit) return t('{field} must be at most {limit} characters.', { field: t(limit[1]), limit: limit[2] })
  const csv = /^Invalid CSV near record (\d+)\. Check the quotes and separators\.$/.exec(message)
  if (csv) return t('Invalid CSV near record {number}. Check the quotes and separators.', { number: csv[1] })
  const invalidList = /^Invalid (.+) list\.$/.exec(message)
  if (invalidList) return t('Invalid {list} list.', { list: t(invalidList[1]) })
  const duplicate = /^Duplicate ID in (.+)\.$/.exec(message)
  if (duplicate) return t('Duplicate ID in {list}.', { list: t(duplicate[1]) })
  return t(message)
}

export function setLocale(value: Locale) {
  if (value !== 'zh' && value !== 'en') return
  current.value = value
  try { globalThis.localStorage?.setItem(storageKey, value) } catch { /* Keep the selection for this tab. */ }
}

if (typeof document !== 'undefined') {
  watch(languageTag, (value) => { document.documentElement.lang = value }, { immediate: true })
}

export function useI18n() {
  return { locale, languageTag, t, setLocale }
}
