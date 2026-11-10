<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { dictionaryLimits, type DictionaryMeaning, type DictionarySense } from '../../../shared/domain/dictionary'
import { t } from '../../i18n/useI18n'

const props = defineProps<{ meaning?: DictionaryMeaning; disabled: boolean }>()
const emit = defineEmits<{ change: [DictionaryMeaning] }>()

function replace(index: number, sense?: DictionarySense) {
  const senses = [...(props.meaning?.senses ?? [])]
  senses.splice(index, index < senses.length ? 1 : 0, ...(sense ? [sense] : []))
  emit('change', { ...props.meaning, senses })
}
function editDefinitions(group: number, sense: DictionarySense, index: number, value?: string) {
  const definitions = [...sense.definitions]
  definitions.splice(index, index < definitions.length ? 1 : 0, ...(value === undefined ? [] : [value]))
  if (!definitions.length) replace(group)
  else replace(group, { ...sense, definitions, source: 'manual' })
}
function updatePart(group: number, sense: DictionarySense, partOfSpeech: string) {
  replace(group, { ...sense, partOfSpeech, source: 'manual' })
}
</script>

<template>
  <div class="dictionary-editor">
    <fieldset v-for="(sense, group) in meaning?.senses" :key="group" :disabled="disabled">
      <legend>{{ t('Meaning group {number}', { number: group + 1 }) }}</legend>
      <div class="library-form">
        <NInput :value="sense.partOfSpeech" :placeholder="t('Part of speech')" :maxlength="dictionaryLimits.partOfSpeech"
          :disabled="disabled" :input-props="{ 'aria-label': t('Part of speech') }"
          @update:value="partOfSpeech => updatePart(group, sense, partOfSpeech)" />
        <NInput :value="sense.domain ?? ''" :placeholder="t('Domain (optional)')" :maxlength="dictionaryLimits.domain"
          :disabled="disabled" :input-props="{ 'aria-label': t('Domain (optional)') }"
          @update:value="domain => replace(group, { ...sense, domain: domain || undefined, source: 'manual' })" />
        <div v-for="(definition, index) in sense.definitions" :key="index" class="dictionary-edit-row">
          <NInput :value="definition" :maxlength="dictionaryLimits.definition" :disabled="disabled"
            :input-props="{ 'aria-label': t('Definition {number}', { number: index + 1 }) }"
            @update:value="value => editDefinitions(group, sense, index, value)" />
          <NButton size="small" :disabled="disabled" :aria-label="t('Remove definition {number}', { number: index + 1 })"
            @click="editDefinitions(group, sense, index)">×</NButton>
        </div>
        <div class="library-actions">
          <NButton size="small" :disabled="disabled || sense.definitions.length >= dictionaryLimits.definitions"
            @click="editDefinitions(group, sense, sense.definitions.length, '')">{{ t('Add definition') }}</NButton>
          <NButton size="small" :disabled="disabled" @click="replace(group)">{{ t('Remove meaning group') }}</NButton>
        </div>
      </div>
    </fieldset>
    <NButton :disabled="disabled || (meaning?.senses.length ?? 0) >= dictionaryLimits.senses"
      @click="replace(meaning?.senses.length ?? 0, { partOfSpeech: '', definitions: [''], source: 'manual' })">
      {{ t('Add meaning group') }}
    </NButton>
  </div>
</template>

<style scoped>
.dictionary-editor { display: grid; gap: .65rem; }
.dictionary-editor fieldset { min-width: 0; margin: 0; border: 1px solid var(--border); border-radius: .5rem; }
.dictionary-edit-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; align-items: center; }
</style>
