<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NCard, NInput } from 'naive-ui'
import { synchronization } from './coordinator'

const { session, data, syncBusy, authBusy, online, status, error, authError, manualSync, authenticate, resolveConflict } = synchronization
const password = ref('')
const resolutionError = ref('')
const resolutionBusy = ref(false)
const alternateTerms = ref<Record<string, string>>({})
const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

async function login() {
  const value = password.value
  password.value = ''
  await authenticate('login', value)
}

async function resolve(id: string, choice: 'server' | 'local') {
  resolutionBusy.value = true
  resolutionError.value = ''
  try {
    await resolveConflict(id, choice, alternateTerms.value[id])
  } catch (cause) {
    resolutionError.value = cause instanceof Error ? cause.message : 'Could not resolve this conflict.'
  } finally {
    resolutionBusy.value = false
  }
}
</script>

<template>
  <NCard class="settings-card">
    <section class="sync-settings" aria-label="Synchronization">
      <h2>Synchronization</h2>
      <p class="sync-status" aria-live="polite">{{ status }}</p>
      <p v-if="session">Signed in as Owner</p>
      <p>{{ data?.pending ?? 0 }} pending operations</p>
      <p v-if="data?.state?.lastSuccessAt">Last successful sync {{ format.format(data.state.lastSuccessAt) }}</p>
      <p class="library-muted">Local data stays in this browser after sign-out. Browser storage is not encrypted by Lexyn.</p>
      <NAlert v-if="authError || error || resolutionError" type="error" role="alert">
        {{ authError || error || resolutionError }}
      </NAlert>
      <NAlert v-if="data?.legacy" type="warning">
        {{ data.legacy }} older operations have no compatible sync format and remain in local storage.
      </NAlert>
      <NAlert v-if="data?.hidden" type="warning">
        A server word is waiting for a local spelling conflict to be resolved.
      </NAlert>
      <form v-if="!session" class="sync-actions" @submit.prevent="login">
        <NInput v-model:value="password" type="password" placeholder="Owner password" :maxlength="256"
          :input-props="{ 'aria-label': 'Owner password', autocomplete: 'current-password' }" />
        <NButton type="primary" attr-type="submit" :disabled="!password || authBusy || !online">Sign in</NButton>
      </form>
      <div v-else class="sync-actions">
        <NButton type="primary" :disabled="syncBusy || authBusy || !online" @click="manualSync">Sync now</NButton>
        <NButton :disabled="authBusy || !online" @click="authenticate('logout')">Sign out</NButton>
      </div>

      <section v-if="data?.issues.length" class="sync-settings" aria-label="Sync issues">
        <h3>Sync issues</h3>
        <article v-for="issue in data.issues" :key="issue.opId" class="sync-issue">
          <p>{{ issue.reason }}</p>
          <template v-if="issue.status === 'conflict'">
            <details>
              <summary>Compare local and server versions</summary>
              <div class="sync-versions">
                <div><strong>Local version</strong><pre>{{ JSON.stringify(issue.local, null, 2) }}</pre></div>
                <div><strong>Server version</strong><pre>{{ issue.remote ? JSON.stringify(issue.remote.value, null, 2) : 'No server record at this ID' }}</pre></div>
              </div>
              <p v-if="issue.blocking?.kind === 'entry'">The server already has “{{ issue.blocking.value.term }}”.</p>
              <p v-if="issue.blocking?.kind === 'deck'">Restore the parent deck “{{ issue.blocking.value.name }}” before resubmitting.</p>
            </details>
            <NInput v-if="issue.blocking?.kind === 'entry'" v-model:value="alternateTerms[issue.opId]"
              placeholder="Different spelling for the local word" :maxlength="240"
              :input-props="{ 'aria-label': 'Different spelling' }" />
            <div class="sync-actions">
              <NButton :disabled="syncBusy || resolutionBusy" @click="resolve(issue.opId, 'server')">Use server version</NButton>
              <NButton :disabled="syncBusy || resolutionBusy" @click="resolve(issue.opId, 'local')">Keep local and resubmit</NButton>
            </div>
          </template>
        </article>
      </section>
    </section>
  </NCard>
</template>

<style scoped>
.sync-settings, .sync-issue { display: grid; gap: 10px; min-width: 0; }
.sync-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sync-actions .n-input { max-width: 280px; }
.sync-issue { border-top: 1px solid var(--line); padding-top: 10px; }
.sync-versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; }
</style>
