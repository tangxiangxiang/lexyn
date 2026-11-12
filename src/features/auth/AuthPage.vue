<script setup lang="ts">
import LanguagePicker from '../../i18n/LanguagePicker.vue'
import { t } from '../../i18n/useI18n'
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NInput, type InputInst } from 'naive-ui'
import { ApiError, authenticate, checkSession, connection, setupMode, setupOwner, setupRequired } from '../../api/client'

defineProps<{ dark: boolean; serviceStatus: string }>()
const emit = defineEmits<{ retry: [] }>()
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const bootstrapToken = ref('')
const submitting = ref(false)
const error = ref('')
const errorCode = ref('')
const retryAfter = ref(0)
const usernameInput = ref<InputInst>()
const tokenInput = ref<InputInst>()
const confirmInput = ref<InputInst>()
const credentialError = computed(() => errorCode.value === 'CREDENTIALS')
const claiming = computed(() => setupMode.value === 'claim')
const creating = computed(() => setupMode.value === 'create')
const ready = computed(() => connection.value !== 'checking' && connection.value !== 'unavailable')

async function focusFirstField() {
  await nextTick()
  if (ready.value) (setupRequired.value ? tokenInput.value : usernameInput.value)?.focus()
}

watch([ready, setupMode], focusFirstField, { immediate: true })

async function submit() {
  if (submitting.value || !ready.value) return
  error.value = ''
  errorCode.value = ''
  if (creating.value && password.value !== confirmPassword.value) {
    error.value = 'The passwords do not match.'
    errorCode.value = 'CONFIRM'
    await nextTick()
    confirmInput.value?.focus()
    return
  }

  submitting.value = true
  try {
    if (setupRequired.value) await setupOwner(bootstrapToken.value.trim(), username.value, password.value)
    else await authenticate(username.value, password.value)
  } catch (cause) {
    if (cause instanceof ApiError) {
      errorCode.value = cause.code
      if (cause.code === 'ALREADY_INITIALIZED') {
        bootstrapToken.value = ''
        password.value = ''
        confirmPassword.value = ''
        await checkSession()
      }
      retryAfter.value = cause.retryAfterSeconds ?? 0
      error.value = cause.code === 'RATE_LIMIT' && retryAfter.value
        ? 'Too many attempts. Try again in {seconds} seconds.'
        : cause.message
    } else {
      error.value = 'Authentication is temporarily unavailable. Try again.'
    }
  } finally {
    submitting.value = false
    if (error.value) await focusFirstField()
  }
}
</script>

<template>
  <main class="app-shell auth-page" :data-theme="dark ? 'dark' : 'light'" aria-labelledby="auth-title">
    <div class="auth-page-brand">
      <img class="auth-page-brand-logo" src="/favicon.svg" width="24" height="24" alt="">
      <span class="auth-page-brand-wordmark">Lexyn</span>
    </div>
    <span class="service-status auth-connection" role="status">{{ serviceStatus }}</span>
    <div v-if="connection === 'unavailable'" class="auth-card">
      <h1 id="auth-title">{{ t('Cannot connect to Lexyn.') }}</h1>
      <p class="auth-subtitle">{{ t('Connect to the server to load and save your work.') }}</p>
      <NButton class="auth-submit" @click="emit('retry')">{{ t('Retry connection') }}</NButton>
    </div>
    <div v-else-if="ready" class="auth-card">
      <h1 id="auth-title">{{ claiming ? t('Choose your username') : creating ? t('Set up Lexyn') : t('Sign in to Lexyn') }}</h1>
      <p class="auth-subtitle">{{ claiming ? t('Choose a username for your existing account.') : creating ? t('Create your Owner account.') : t('Welcome back to your vocabulary studio.') }}</p>
      <p v-if="connection === 'expired'" class="auth-notice" role="status">{{ t('Your session expired. Sign in to continue.') }}</p>
      <form class="auth-form" autocomplete="off" :aria-busy="submitting" @submit.prevent="submit">
        <div v-if="setupRequired" class="auth-field">
          <label for="setup-token">{{ t('Setup token') }}</label>
          <NInput ref="tokenInput" v-model:value="bootstrapToken" class="auth-control" type="password" :disabled="submitting"
            :status="errorCode === 'SETUP_TOKEN' ? 'error' : undefined"
            :input-props="{ id: 'setup-token', required: true, autocomplete: 'off', spellcheck: false,
              'aria-describedby': errorCode === 'SETUP_TOKEN' ? 'setup-token-help auth-error' : 'setup-token-help' }" />
          <p id="setup-token-help" class="auth-help">{{ t('Copy the one-time token from the terminal running Lexyn.') }}</p>
        </div>
        <div class="auth-field">
          <label for="auth-username">{{ t('Username') }}</label>
          <NInput ref="usernameInput" v-model:value="username" class="auth-control" :maxlength="32" :disabled="submitting"
            :status="credentialError ? 'error' : undefined"
            :input-props="{ id: 'auth-username', name: 'username', autocomplete: 'username', required: true,
              autocapitalize: 'none', spellcheck: false, 'aria-invalid': credentialError || undefined,
              'aria-describedby': credentialError ? 'auth-error' : setupRequired ? 'auth-username-help' : undefined }" />
          <p v-if="setupRequired" id="auth-username-help" class="auth-help">{{ t('Use 3–32 letters, numbers, dots, underscores or hyphens. Start and end with a letter or number.') }}</p>
        </div>
        <div class="auth-field">
          <label for="auth-password">{{ claiming ? t('Current Owner password') : t('Owner password') }}</label>
          <NInput v-model:value="password" class="auth-control" type="password" :maxlength="512" :disabled="submitting"
            :status="credentialError ? 'error' : undefined"
            :input-props="{ id: 'auth-password', name: 'password', required: true,
              autocomplete: creating ? 'new-password' : 'current-password',
              'aria-invalid': credentialError || undefined, 'aria-describedby': credentialError ? 'auth-error' : undefined }" />
          <p v-if="creating" class="auth-help">{{ t('Use at least 12 characters.') }}</p>
        </div>
        <div v-if="creating" class="auth-field">
          <label for="confirm-password">{{ t('Confirm password') }}</label>
          <NInput ref="confirmInput" v-model:value="confirmPassword" class="auth-control" type="password" :maxlength="512"
            :disabled="submitting" :status="errorCode === 'CONFIRM' ? 'error' : undefined"
            :input-props="{ id: 'confirm-password', required: true, autocomplete: 'new-password',
              'aria-invalid': errorCode === 'CONFIRM' || undefined,
              'aria-describedby': errorCode === 'CONFIRM' ? 'auth-error' : undefined }" />
        </div>
        <p v-if="error" id="auth-error" class="auth-error" role="alert">{{ t(error, { seconds: retryAfter }) }}</p>
        <NButton class="auth-submit" attr-type="submit" type="primary" :disabled="submitting">
          {{ submitting ? t('Please wait…') : claiming ? t('Save username') : creating ? t('Create Owner') : t('Sign in') }}
        </NButton>
      </form>
      <div class="auth-language"><LanguagePicker /></div>
    </div>
    <h1 v-else id="auth-title" class="auth-help">{{ t('Connecting to Lexyn…') }}</h1>
  </main>
</template>

<style scoped>
.auth-page.app-shell {
  position: relative;
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
  padding: max(64px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) 32px max(20px, env(safe-area-inset-left));
}
.auth-page-brand {
  position: absolute;
  top: max(12px, env(safe-area-inset-top));
  left: max(12px, env(safe-area-inset-left));
  display: flex;
  align-items: center;
  gap: 8px;
}
.auth-page-brand-logo { display: block; flex-shrink: 0; object-fit: contain; }
.auth-page-brand-wordmark {
  font-family: ui-rounded, "SF Pro Rounded", "Avenir Next", sans-serif;
  font-size: 0.9rem;
  font-weight: 700;
}
.auth-connection {
  position: absolute;
  top: max(12px, env(safe-area-inset-top));
  right: max(12px, env(safe-area-inset-right));
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: 99px;
  font-size: 11px;
}
.auth-card {
  width: min(100%, 380px);
  padding: clamp(18px, 6vw, 28px);
  border: 1px solid var(--line);
  border-radius: var(--panel-radius);
  background: var(--panel);
}
.auth-card h1 { margin: 0; font-size: 1.45rem; }
.auth-subtitle { margin: 8px 0 22px; color: var(--muted); font-size: 0.86rem; line-height: 1.5; }
.auth-notice {
  margin: -6px 0 16px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 6px;
  background: var(--accent-surface);
  font-size: 0.8rem;
}
.auth-language { display: flex; justify-content: center; margin-top: 18px; }
.auth-form { display: grid; gap: 14px; }
.auth-field { display: grid; gap: 5px; }
.auth-field label { font-size: 0.8rem; font-weight: 600; }
.auth-help { margin: -1px 0 0; color: var(--muted); font-size: 0.73rem; line-height: 1.45; }
.auth-control { width: 100%; min-height: 44px; border-radius: 6px; font-size: 0.86rem; }
.auth-error { margin: 0; color: var(--danger); font-size: 0.8rem; line-height: 1.4; }
.auth-submit { min-height: 44px; margin-top: 4px; border-radius: 6px; font-size: 0.84rem; font-weight: 600; }
.auth-form[aria-busy="true"] .auth-submit { cursor: wait; }
</style>
