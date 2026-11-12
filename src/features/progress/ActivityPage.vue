<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import AppIcon from '../../components/AppIcon.vue'
import { study } from '../../api/client'
import { t, useI18n } from '../../i18n/useI18n'
import { useLibraryQuery } from '../library/useLibraryQuery'

const { languageTag } = useI18n()
const { data, error, reload } = useLibraryQuery(() => null, (_, signal) => study('progress/activity', [], { signal }))
const monthOffset = ref(0)
const weekdayFormat = computed(() => new Intl.DateTimeFormat(languageTag.value, { weekday: 'short', timeZone: 'UTC' }))
const dateFormat = computed(() => new Intl.DateTimeFormat(languageTag.value, { dateStyle: 'long', timeZone: 'UTC' }))
const weekdays = computed(() => Array.from({ length: 7 }, (_, index) =>
  weekdayFormat.value.format(Date.UTC(2024, 0, index + 1))))
const calendar = computed(() => {
  if (!data.value) return
  const today = new Date(data.value.today + 'T00:00:00Z')
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + monthOffset.value, 1))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
  const studiedDays = new Set(data.value.days)
  const days = Array.from({ length: end.getUTCDate() }, (_, index) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), index + 1))
    const key = date.toISOString().slice(0, 10)
    return { key, number: index + 1, label: dateFormat.value.format(date),
      studied: studiedDays.has(key), future: key > data.value!.today }
  })
  return { month: start.toISOString().slice(0, 7).replace('-', '/'), leading: (start.getUTCDay() + 6) % 7, days }
})
</script>

<template>
  <section class="page spell-subpage spell-activity">
    <header class="spell-subpage-toolbar">
      <RouterLink class="icon-control" to="/study" :aria-label="t('Lexyn home')"><AppIcon name="close" /></RouterLink>
      <h1>{{ t('Study activity') }}</h1>
      <RouterLink class="spell-chip" to="/progress">{{ t('Learning plan') }}</RouterLink>
    </header>
    <NAlert v-if="error" type="error">
      {{ t('Your progress could not be loaded from the server.') }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
    </NAlert>
    <p v-else-if="!data || !calendar" aria-live="polite">{{ t('Loading your progress…') }}</p>
    <template v-else>
      <div class="spell-month-nav">
        <button type="button" class="icon-control" :aria-label="t('Previous month')" @click="monthOffset--"><AppIcon name="chevronLeft" /></button>
        <h2 aria-live="polite">{{ calendar.month }}</h2>
        <button type="button" class="icon-control" :disabled="monthOffset === 0" :aria-label="t('Next month')" @click="monthOffset++"><AppIcon name="chevronRight" /></button>
      </div>
      <div class="spell-streak" :class="{ 'streak-lit': data.streak >= 2 }">
        <svg viewBox="0 0 100 112" aria-hidden="true"><path d="M45 4Q50 1 55 4L91 25Q97 28 97 35V77Q97 84 91 87L55 108Q50 111 45 108L9 87Q3 84 3 77V35Q3 28 9 25Z" /></svg>
        <strong>{{ data.streak }}</strong>
      </div>
      <h2 class="spell-streak-label">{{ t('Study streak') }}</h2>
      <div class="spell-calendar" :aria-label="t('Study calendar')">
        <span v-for="day in weekdays" :key="day" class="spell-weekday">{{ day }}</span>
        <span v-for="index in calendar.leading" :key="'empty-' + index" aria-hidden="true"></span>
        <time v-for="day in calendar.days" :key="day.key" :datetime="day.key" :aria-current="day.key === data.today ? 'date' : undefined"
          :class="{ 'day-studied': day.studied, 'day-future': day.future }"
          :aria-label="day.studied ? t('Studied on {date}', { date: day.label }) : day.label">
          <span>{{ day.number }}</span>
        </time>
      </div>
    </template>
  </section>
</template>
