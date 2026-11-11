<script setup lang="ts">
import { NButton, NInputNumber } from 'naive-ui'
import { listSizes } from '../../../shared/domain/library'
import { t } from '../../i18n/useI18n'

defineProps<{ id: string; disabled: boolean }>()
const size = defineModel<number | null>({ required: true })
const presets = [20, 30, 50]
</script>

<template>
  <label :for="id">{{ t('Words per list') }}</label>
  <div class="list-size-options">
    <NButton v-for="preset in presets" :key="preset" size="small" secondary :disabled="disabled"
      :aria-pressed="size === preset" :type="size === preset ? 'primary' : 'default'" @click="size = preset">
      {{ preset }}
    </NButton>
    <NInputNumber v-model:value="size" :min="listSizes.min" :max="listSizes.max" :step="1"
      :input-props="{ id, 'aria-describedby': id + '-help' }" :disabled="disabled" />
  </div>
  <p :id="id + '-help'" class="library-muted">{{ t('Choose 20, 30, 50, or enter a custom size. This is separate from the daily learning limit.') }}</p>
</template>
