<script setup lang="ts">
import { NRadioButton, NRadioGroup } from 'naive-ui'
import { useI18n } from './useI18n'

const { locale, setLocale, t } = useI18n()
</script>

<template>
  <NRadioGroup name="display-language" :aria-label="t('Language')" :value="locale" @update:value="setLocale">
    <NRadioButton value="zh" lang="zh-CN">简体中文</NRadioButton>
    <NRadioButton value="en" lang="en">English</NRadioButton>
  </NRadioGroup>
</template>
