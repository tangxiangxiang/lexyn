<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import { study, ApiError } from '../../api/client'
import { t, translateError } from '../../i18n/useI18n'
import { learningPreferences } from '../../ui/learningPreferences'
import { useLibraryAction } from '../library/library-ui'
import { review, reviewSessionRoute } from '../review/api'
import { learn, learnSessionRoute } from './api'
import type { StudyEndpoints } from '../../../shared/contracts/study'

type Result = StudyEndpoints['learn/all']['result']
const route = useRoute()
const router = useRouter()
const deck = computed(() => typeof route.query.deckId === 'string' ? route.query.deckId : '')
const flow = computed(() => typeof route.query.flow === 'string' ? route.query.flow : undefined)
const result = shallowRef<Result>()
const { busy, error, run } = useLibraryAction()

async function advance(deckId: string, flowId?: string) {
  const path = route.fullPath
  const next = await study('learn/all', [deckId, learningPreferences.value.defaultMode, flowId], { write: true })
  if (route.fullPath !== path) return
  result.value = next
  if (next.kind === 'review') await router.replace(reviewSessionRoute(next.session, next.flowId))
  if (next.kind === 'learn') await router.replace(learnSessionRoute(next.session, undefined, next.flowId))
}

function start() {
  if (deck.value) void run(() => advance(deck.value, flow.value))
}
watch([deck, flow], start, { immediate: true })

const existingRoute = computed(() => {
  const conflict = result.value
  if (conflict?.kind === 'review-conflict') return reviewSessionRoute(conflict.session)
  if (conflict?.kind === 'learn-conflict') return { path: '/learn', query: {
    deckId: conflict.session.deckId, listId: conflict.session.listId, session: conflict.session.sessionId,
  } }
})

function endPrevious() {
  const conflict = result.value
  const deckId = deck.value
  if (conflict?.kind !== 'review-conflict' && conflict?.kind !== 'learn-conflict') return
  const { sessionId, revision } = conflict.session
  void run(async () => {
    try {
      if (conflict.kind === 'review-conflict') await review.setStatus(sessionId, 'abandoned', revision)
      else await learn.setStatus(sessionId, 'abandoned', revision)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await advance(deckId, conflict.flowId)
        return
      }
      throw cause
    }
    await advance(deckId, conflict.flowId)
  })
}
</script>

<template>
  <section class="page study-result">
    <NAlert v-if="error" type="error" role="alert">
      {{ translateError(error) }} <NButton text @click="start">{{ t('Try again') }}</NButton>
    </NAlert>
    <template v-else-if="result?.kind === 'complete'">
      <h1>{{ t(result.ended ? 'Session ended' : 'Session complete') }}</h1>
      <div class="learn-result-grid study-result-grid">
        <div><strong>{{ result.reviewed }}</strong><span>{{ t('Cards rated') }}</span></div>
        <div><strong>{{ result.learned }}</strong><span>{{ t('New words learned') }}</span></div>
      </div>
      <p role="status">{{ result.pending ? t(result.pending === 1 ? '1 study item remaining.' : '{count} study items remaining.', { count: result.pending }) : t('Today’s tasks are complete.') }}</p>
    </template>
    <template v-else-if="existingRoute">
      <h1>{{ t('Another study session is open') }}</h1>
      <p>{{ t('Continue that session or end it before starting here.') }}</p>
      <div class="learn-actions">
        <RouterLink class="book-continue" :to="existingRoute">{{ t('Continue existing session') }}</RouterLink>
        <NButton :disabled="busy" @click="endPrevious">{{ t('End existing session and start') }}</NButton>
      </div>
    </template>
    <p v-else-if="result?.kind === 'empty'" role="status">{{ t('No study items are ready right now.') }}</p>
    <p v-else-if="!deck">{{ t('Choose an active deck to start learning.') }}</p>
    <p v-else role="status">{{ t('Checking your study tasks…') }}</p>
    <RouterLink to="/study" class="library-back">{{ t('Back to study') }}</RouterLink>
  </section>
</template>
