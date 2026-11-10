<script setup lang="ts">
import { NAlert, NButton, NCard } from 'naive-ui'
import { t, translateError } from '../../i18n/useI18n'
import { dictionary } from '../library/dictionary-api'
import { useLibraryQuery } from '../library/useLibraryQuery'

const { data, error, reload } = useLibraryQuery(() => null, (_key, signal) => dictionary.status(signal))
</script>

<template>
  <NCard class="settings-card" :title="t('Dictionary')">
    <NAlert v-if="error" type="error">
      {{ translateError(error) }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
    </NAlert>
    <template v-else-if="data">
      <p>{{ t(data.installed ? 'ECDICT installed' : 'ECDICT unavailable') }}</p>
      <p v-if="data.installed">{{ t('Word count: {count}', { count: data.wordCount }) }}</p>
      <p v-if="data.sourceCommit">{{ t('Dictionary source revision: {commit}', { commit: data.sourceCommit }) }}</p>
      <p v-if="data.error" class="library-muted">{{ data.error }}</p>
      <p class="library-muted">{{ t('Install or update ECDICT using the server CLI.') }}</p>
    </template>
  </NCard>
</template>
