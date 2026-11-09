<script setup lang="ts">
import { NAlert, NCard, NRadioButton, NRadioGroup } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import { useAppearance } from '../../ui/appearance'

const { appearance, busy, error, setAppearance } = useAppearance()
</script>

<template>
  <section class="page">
    <header class="page-intro">
      <h1>Settings</h1>
      <p>Make Lexyn feel at home on this device.</p>
    </header>
    <NCard class="settings-card">
      <div class="setting-row">
        <span class="setting-icon"><AppIcon name="appearance" /></span>
        <div class="setting-copy">
          <h2>Appearance</h2>
          <p>Choose a theme for this browser.</p>
        </div>
        <NRadioGroup name="appearance" aria-label="Appearance" :value="appearance" :disabled="busy"
          @update:value="setAppearance">
          <NRadioButton value="system">System</NRadioButton>
          <NRadioButton value="light">Light</NRadioButton>
          <NRadioButton value="dark">Dark</NRadioButton>
        </NRadioGroup>
      </div>
      <NAlert v-if="error" class="settings-error" type="error" role="alert">{{ error }}</NAlert>
    </NCard>
  </section>
</template>
