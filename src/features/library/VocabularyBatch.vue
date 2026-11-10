<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { NAlert, NButton, NProgress } from 'naive-ui'
import type { VocabularyJob, VocabularyPlan } from '../../../shared/contracts/vocabulary'
import { refreshStudy } from '../../api/client'
import { t, translateError } from '../../i18n/useI18n'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'
import { vocabulary } from './vocabulary-api'

const props = defineProps<{ deckId: string; showEntry: boolean }>()
const open = ref(false)
const plan = ref<VocabularyPlan>()
const loadError = ref('')
const { busy, error, run } = useLibraryAction()
const job = computed(() => plan.value?.job)
const running = computed(() => job.value?.status === 'pending' || job.value?.status === 'running')
const count = computed(() => plan.value ? Math.min(plan.value.missing, plan.value.limit) : 0)
const labels: Record<VocabularyJob['status'], string> = {
  pending: 'Waiting for generation',
  running: 'AI vocabulary task running',
  completed: 'AI vocabulary task completed',
  failed: 'AI vocabulary task failed',
  cancelled: 'AI vocabulary task stopped',
  interrupted: 'AI vocabulary task interrupted',
}

let request: AbortController | undefined
let attempt: { count: number; requestId: string; afterTaskId: string | null } | undefined

async function reload() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loadError.value = ''
  try {
    const previous = job.value
    const next = await vocabulary.plan(props.deckId, controller.signal)
    if (controller.signal.aborted) return
    plan.value = next
    if (previous?.id === next.job?.id && next.job?.succeeded && !running.value
      && (previous?.status === 'pending' || previous?.status === 'running')) {
      await refreshStudy()
    }
  } catch (error) {
    if (!controller.signal.aborted) loadError.value = error instanceof Error ? error.message : 'Vocabulary task could not be read or saved.'
  } finally { if (request === controller) request = undefined }
}

watch(open, (value) => { if (value) void reload() })
watch([plan, busy, loadError], (_current, _previous, cleanup) => {
  if (!running.value || busy.value || loadError.value) return
  const timer = setTimeout(reload, 1500)
  cleanup(() => clearTimeout(timer))
})
onScopeDispose(() => request?.abort())
void reload()

function start() {
  if (!plan.value || !count.value || running.value || busy.value) return
  const afterTaskId = job.value?.id ?? null
  if (!attempt || attempt.count !== count.value || attempt.afterTaskId !== afterTaskId) {
    attempt = { count: count.value, requestId: crypto.randomUUID(), afterTaskId }
  }
  const input = attempt
  request?.abort()
  void run(async () => {
    const current = await vocabulary.start(props.deckId, input)
    if (plan.value) plan.value = { ...plan.value, job: current }
    attempt = undefined
    await reload()
  })
}

function stop() {
  const current = job.value
  if (!current || !running.value || busy.value) return
  request?.abort()
  void run(async () => {
    const cancelled = await vocabulary.cancel(props.deckId, current.id)
    if (plan.value) plan.value = { ...plan.value, job: cancelled }
    await reload()
    await refreshStudy()
  })
}
</script>

<template>
  <NButton v-if="showEntry || running" @click="open = true">
    {{ t(running ? 'View AI task progress' : 'AI fill missing meanings') }}
  </NButton>
  <LibraryDialog v-if="open" :title="t('AI fill missing meanings')" :busy="busy" @close="open = false">
    <div class="library-form">
      <NAlert v-if="loadError || error" type="error" role="alert">
        {{ translateError(loadError || error) }}
        <NButton v-if="loadError" text @click="reload">{{ t('Retry') }}</NButton>
      </NAlert>
      <template v-if="plan">
        <template v-if="job">
          <p role="status">{{ t(labels[job.status]) }}</p>
          <NProgress :percentage="Math.round(job.processed / job.total * 100)" />
          <p>{{ t('Total {total} · processed {processed}', { total: job.total, processed: job.processed }) }}</p>
          <p>{{ t('Saved {saved} · failed {failed} · skipped {skipped} · suggested checks {checks}', {
            saved: job.succeeded, failed: job.failed, skipped: job.skipped, checks: job.needsReview,
          }) }}</p>
          <p v-if="job.conflicts">{{ t('{count} skipped because the words changed', { count: job.conflicts }) }}</p>
          <p v-if="job.error" class="library-muted">{{ translateError(job.error) }}</p>
          <NButton v-if="running" :disabled="busy" @click="stop">{{ t('Stop AI task') }}</NButton>
        </template>
        <template v-if="!running && !loadError">
          <p>{{ t('Text model: {model}', { model: plan.model }) }}</p>
          <p v-if="count">
            {{ t('{missing} words need a meaning in this deck. This task will process up to {count}, with a limit of {limit} per task. Generation may use MiniMax credits.',
              { missing: plan.missing, count, limit: plan.limit }) }}
          </p>
          <p v-else>{{ t('No words need a meaning') }}</p>
          <NButton v-if="count" type="primary" :disabled="busy" @click="start">
            {{ t(job ? 'Continue with up to {count} missing words' : 'Start AI task for {count} words', { count }) }}
          </NButton>
        </template>
      </template>
      <p v-else-if="!loadError" role="status">{{ t('Loading vocabulary task…') }}</p>
    </div>
  </LibraryDialog>
</template>
