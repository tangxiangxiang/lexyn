<script setup lang="ts">
import { computed } from 'vue'
import type { PhoneticVariants } from '../../../shared/domain/dictionary'
import { t } from '../../i18n/useI18n'

const props = defineProps<{ phonetics?: PhoneticVariants; legacy?: string }>()
const values = computed(() => {
  if (props.phonetics?.british || props.phonetics?.american) return [
    ...(props.phonetics.british ? [{ label: 'British', value: props.phonetics.british }] : []),
    ...(props.phonetics.american ? [{ label: 'American', value: props.phonetics.american }] : []),
  ]
  const unspecified = props.phonetics?.unspecified || props.legacy
  return unspecified ? [{ label: 'Unspecified', value: unspecified }] : []
})
</script>

<template>
  <p v-if="values.length" class="phonetics">
    <span v-for="(item, index) in values" :key="item.label">{{ index ? ' · ' : '' }}{{ t(item.label) }} {{ item.value }}</span>
  </p>
</template>

<style scoped>
.phonetics { display: flex; flex-wrap: wrap; gap: .25rem .8rem; color: var(--muted); }
</style>
