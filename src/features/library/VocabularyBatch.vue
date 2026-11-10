<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { NAlert, NButton, NProgress } from 'naive-ui'
import type { VocabularyJob, VocabularyMode, VocabularyPlan } from '../../../shared/contracts/vocabulary'
import { refreshStudy } from '../../api/client'
import { t, translateError } from '../../i18n/useI18n'
import LibraryDialog from './LibraryDialog.vue'
import { useLibraryAction } from './library-ui'
import { vocabulary } from './vocabulary-api'

const props = defineProps<{ deckId: string; showEntry: boolean }>()
const open = ref(false)
const selectedMode = ref<VocabularyMode>('meaning')
const plan = ref<VocabularyPlan>()
const loadError = ref('')
const { busy, error, run } = useLibraryAction()
const latestJob = computed(() => plan.value?.job)
const running = computed(() => latestJob.value?.status === 'pending' || latestJob.value?.status === 'running')
const mode = computed(() => running.value ? latestJob.value?.mode ?? 'meaning' : selectedMode.value)
const ipa = computed(() => mode.value === 'phonetics')
const job = computed(() => (latestJob.value?.mode ?? 'meaning') === mode.value ? latestJob.value : undefined)
const missing = computed(() => (ipa.value ? plan.value?.missingPhonetics : plan.value?.missing) ?? 0)
const count = computed(() => Math.min(missing.value, plan.value?.limit ?? 0))
const labels: Record<VocabularyJob['status'], string> = {
  pending: 'Waiting for generation',
  running: 'AI vocabulary task running',
  completed: 'AI vocabulary task completed',
  failed: 'AI vocabulary task failed',
  cancelled: 'AI vocabulary task stopped',
  interrupted: 'AI vocabulary task interrupted',
}

let request: AbortController | undefined
let attempt: Parameters<typeof vocabulary.start>[1] | undefined

async function reload() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loadError.value = ''
  try {
    const previous = latestJob.value
    const next = await vocabulary.plan(props.deckId, controller.signal)
    if (controller.signal.aborted) return
    if (open.value && (next.job?.status === 'pending' || next.job?.status === 'running')) {
      selectedMode.value = next.job.mode ?? 'meaning'
    }
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

function show(nextMode: VocabularyMode) {
  selectedMode.value = nextMode
  open.value = true
}

function start() {
  if (!plan.value || !count.value || running.value || busy.value) return
  const afterTaskId = latestJob.value?.id ?? null
  if (!attempt || attempt.count !== count.value || attempt.afterTaskId !== afterTaskId || attempt.mode !== mode.value) {
    attempt = { count: count.value, requestId: crypto.randomUUID(), afterTaskId, mode: mode.value }
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
  <NButton v-if="running" @click="show(latestJob?.mode ?? 'meaning')">{{ t('View AI task progress') }}</NButton>
  <NButton v-else-if="showEntry" @click="show('meaning')">{{ t('AI fill missing meanings') }}</NButton>
  <NButton v-if="!running" @click="show('phonetics')">{{ t('AI fill missing IPA') }}</NButton>
  <LibraryDialog v-if="open" :title="t(ipa ? 'AI fill missing IPA' : 'AI fill missing meanings')" :busy="busy" @close="open = false">
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
          <p v-if="job.dictionarySaved !== undefined">{{ t('AI optimized {ai} · ECDICT reference {dictionary} · not found {missing}', {
            dictionary: job.dictionarySaved, ai: job.aiSaved ?? 0, missing: job.notFound ?? 0,
          }) }}</p>
          <p v-if="job.conflicts">{{ t('{count} skipped because the words changed', { count: job.conflicts }) }}</p>
          <p v-if="job.error" class="library-muted">{{ translateError(job.error) }}</p>
          <NButton v-if="running" :disabled="busy" @click="stop">{{ t('Stop AI task') }}</NButton>
        </template>
        <template v-if="!running && !loadError">
          <p>{{ t(ipa ? 'MiniMax fills missing British and American IPA. Saved meanings and existing accents are preserved.'
            : 'Every selected word is optimized by MiniMax using its latest saved meaning and ECDICT as reference when available.') }}</p>
          <p>{{ t('Text model: {model}', { model: plan.model }) }}</p>
          <p v-if="count">
            {{ t(ipa ? '{missing} words need IPA. This task will process up to {count}. Generation may use MiniMax credits.'
              : '{missing} words need a structured meaning in this deck. This task will process up to {count}, with a limit of {limit} per task. Generation may use MiniMax credits.',
              { missing, count, limit: plan.limit }) }}
          </p>
          <p v-else>{{ t(ipa ? 'No words need IPA.' : 'No words need a meaning') }}</p>
          <NButton v-if="count" type="primary" :disabled="busy" @click="start">
            {{ t(ipa ? (job ? 'Retry IPA backfill ({count})' : 'Fill missing IPA ({count})')
              : (job ? 'Continue with up to {count} missing words' : 'Start AI task for {count} words'), { count }) }}
          </NButton>
        </template>
      </template>
      <p v-else-if="!loadError" role="status">{{ t('Loading vocabulary task…') }}</p>
    </div>
  </LibraryDialog>
</template>
