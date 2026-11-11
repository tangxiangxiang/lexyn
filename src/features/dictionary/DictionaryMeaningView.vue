<script setup lang="ts">
import { computed } from 'vue'
import type { DictionaryMeaning } from '../../../shared/domain/dictionary'
import { t } from '../../i18n/useI18n'

const props = defineProps<{ meaning: DictionaryMeaning; compact?: boolean }>()
const groups = computed(() => {
  const byPos = new Map<string, { domain?: string; definitions: string[] }[]>()
  for (const sense of props.meaning.senses) {
    const pos = sense.partOfSpeech.trim()
    const domain = sense.domain?.trim() || undefined
    const values = byPos.get(pos) ?? []
    const group = values.find((row) => row.domain === domain)
    if (group) {
      for (const definition of sense.definitions) if (!group.definitions.includes(definition)) group.definitions.push(definition)
    } else values.push({ domain, definitions: [...new Set(sense.definitions)] })
    byPos.set(pos, values)
  }
  return [...byPos]
})
</script>

<template>
  <div class="dictionary-meaning">
    <div v-for="[pos, senses] in groups" :key="pos" class="dictionary-group"
      :class="{ 'dictionary-compact': compact, 'dictionary-no-pos': compact && !pos }">
      <span v-if="pos || !compact" class="dictionary-pos">{{ pos || t('Unlabelled sense') }}</span>
      <div class="dictionary-glosses">
        <div v-for="(sense, index) in senses" :key="index">
          <small v-if="sense.domain" class="dictionary-domain">[{{ sense.domain }}] </small>
          <span v-for="(definition, i) in sense.definitions" :key="i">{{ i ? '；' : '' }}<span class="dictionary-definition">{{ definition }}</span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dictionary-meaning { display: grid; gap: .45rem; text-align: left; overflow-wrap: anywhere; }
.dictionary-group { display: grid; grid-template-columns: minmax(0, 3.5rem) minmax(0, 1fr); gap: .65rem; }
.dictionary-group.dictionary-compact { grid-template-columns: minmax(0, 2.4rem) minmax(0, 1fr); gap: .4rem; }
.dictionary-group.dictionary-no-pos { grid-template-columns: minmax(0, 1fr); }
.dictionary-pos { color: var(--muted); font-size: .85em; font-weight: 600; }
.dictionary-glosses { display: grid; grid-template-columns: minmax(0, 1fr); gap: .25rem; }
.dictionary-domain { color: var(--muted); font-size: .8em; }
.dictionary-definition { white-space: pre-wrap; }
@media (max-width: 420px) {
  .dictionary-group:not(.dictionary-compact) { grid-template-columns: minmax(0, 1fr); gap: .1rem; }
}
</style>
