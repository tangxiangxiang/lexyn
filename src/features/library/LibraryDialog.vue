<script setup lang="ts">
import { NModal } from 'naive-ui'

defineProps<{ title: string; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <NModal :show="true" preset="card" class="library-dialog" :title="title"
    :closable="!busy" :mask-closable="false" :close-on-esc="!busy"
    @update:show="(show) => { if (!show) emit('close') }">
    <slot />
  </NModal>
</template>
