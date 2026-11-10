<script setup lang="ts">
import { computed } from 'vue'
import { formatPhonetic, type PhoneticVariants } from '../../../shared/domain/dictionary'
import { t } from '../../i18n/useI18n'

const props = defineProps<{ phonetics?: PhoneticVariants; legacy?: string }>()
const values = computed(() => {
  const accents = [
    { label: 'UK', value: formatPhonetic(props.phonetics?.british) },
    { label: 'US', value: formatPhonetic(props.phonetics?.american) },
  ].filter(({ value }) => value)
  if (accents.length) return accents
  const unspecified = formatPhonetic(props.phonetics?.unspecified) || formatPhonetic(props.legacy)
  return unspecified ? [{ label: '', value: unspecified }] : []
})
</script>

<template>
  <p v-if="values.length" class="phonetics">
    <span v-for="item in values" :key="item.label">{{ item.label ? t(item.label) + ' ' : '' }}{{ item.value }}</span>
  </p>
</template>

<style scoped>
.phonetics { display: flex; flex-wrap: wrap; gap: .25rem .8rem; color: var(--muted); overflow-wrap: anywhere; }
</style>
