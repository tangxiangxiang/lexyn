<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { t } from '../i18n/useI18n'

const menu = ref<HTMLDetailsElement>()
const trigger = ref<HTMLElement>()

function close() {
  if (!menu.value?.open) return
  menu.value.open = false
  trigger.value?.focus()
}
</script>

<template>
  <details ref="menu" class="session-menu" @keydown.esc.stop="close">
    <summary ref="trigger" class="icon-control" :aria-label="t('Session options')">
      <AppIcon name="more" />
    </summary>
    <div class="session-menu-actions" @click="close"><slot /></div>
  </details>
</template>

<style scoped>
.session-menu { position: relative; z-index: 4; }
summary { border-radius: 50%; background: var(--glass); }
summary::-webkit-details-marker { display: none; }
.session-menu-actions {
  display: grid;
  position: absolute;
  inset-inline-end: 0;
  top: calc(100% + 4px);
  min-width: max-content;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--paper);
}
.session-menu-actions :deep(:is(a, button)) {
  display: flex;
  align-items: center;
  justify-content: start;
  min-height: 44px;
  padding-inline: 10px;
  border-radius: 8px;
  color: var(--ink);
  text-decoration: none;
}
.session-menu-actions :deep(:is(a, button):hover) { background: var(--hover-surface); }
</style>
