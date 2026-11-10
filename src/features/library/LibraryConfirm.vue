<script setup lang="ts">
import { t, translateError } from '../../i18n/useI18n'
import { NAlert, NButton } from 'naive-ui'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'

const props = defineProps<{ title: string; description: string; label: string; action: () => Promise<void> }>()
const emit = defineEmits<{ close: []; done: [] }>()
const { busy, error, run } = useLibraryAction()

async function confirm() {
  if (await run(async () => { await props.action(); return true })) emit('done')
}
</script>

<template>
  <LibraryDialog :title="title" :busy="busy" @close="emit('close')">
    <div class="library-form">
      <p class="library-dialog-copy">{{ description }}</p>
      <NAlert v-if="error" type="error" role="alert">{{ translateError(error) }}</NAlert>
      <div class="library-dialog-actions">
        <NButton :disabled="busy" @click="emit('close')">{{ t('Cancel') }}</NButton>
        <NButton type="error" :loading="busy" @click="confirm">{{ label }}</NButton>
      </div>
    </div>
  </LibraryDialog>
</template>
