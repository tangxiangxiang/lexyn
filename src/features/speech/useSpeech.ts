import { onScopeDispose, ref, watch } from 'vue'
import type { PreparedSpeech, SpeechSettings, SpeechSettingsUpdate, SpeechVoice } from '../../../shared/contracts/speech'
import { requestSpeech, session } from '../../api/client'

type Target = { entryId: string } | { voiceId: SpeechVoice }

export const speechSettings = {
  read: (signal?: AbortSignal) => requestSpeech<SpeechSettings>('settings', 'GET', undefined, signal),
  save: (values: SpeechSettingsUpdate) => requestSpeech<SpeechSettings>('settings', 'PUT', values),
}

export function useSpeech(target: () => Target, identity: () => string) {
  const state = ref<'idle' | 'loading' | 'ready' | 'playing' | 'error'>('idle')
  const error = ref('')
  let pending: AbortController | undefined
  let player: HTMLAudioElement | undefined
  let url: string | undefined

  function release() {
    pending?.abort()
    pending = undefined
    if (player) {
      player.onended = null
      player.onerror = null
      player.pause()
      player.removeAttribute('src')
      player = undefined
    }
    if (url) URL.revokeObjectURL(url)
    url = undefined
    state.value = 'idle'
    error.value = ''
  }
  function playbackFailed(message: string, keepSource = false) {
    if (!keepSource) release()
    state.value = keepSource ? 'ready' : 'error'
    error.value = message
  }
  async function start(audio: HTMLAudioElement) {
    state.value = 'playing'
    try { await audio.play() }
    catch (reason) {
      if (player === audio && state.value === 'playing') {
        const blocked = reason instanceof DOMException && reason.name === 'NotAllowedError'
        playbackFailed(blocked ? 'Audio is ready. Tap play again.' : 'Speech could not be played. Try again.', blocked)
      }
    }
  }
  async function toggle() {
    if (state.value === 'loading') return
    if (state.value === 'playing' && player) {
      player.pause()
      state.value = 'ready'
      return
    }
    error.value = ''
    if (state.value === 'ready' && player) { await start(player); return }
    const controller = new AbortController()
    pending = controller
    state.value = 'loading'
    try {
      const source = target()
      const { audioId, playbackRate } = await requestSpeech<PreparedSpeech>(
        'entryId' in source ? 'prepare' : 'preview', 'POST', source, controller.signal)
      if (!/^[a-f0-9]{64}$/.test(audioId)) throw new Error('Speech could not be played. Try again.')
      const blob = await requestSpeech<Blob>('audio/' + audioId, 'GET', undefined, controller.signal, async (response) => {
        if (response.headers.get('Content-Type') !== 'audio/mpeg') throw new Error('Speech could not be played. Try again.')
        return response.blob()
      })
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      player = audio
      audio.playbackRate = playbackRate
      audio.onended = () => { if (player === audio) release() }
      audio.onerror = () => { if (player === audio) playbackFailed('Speech could not be played. Try again.') }
      await start(audio)
    } catch (reason) {
      if (!controller.signal.aborted) playbackFailed(reason instanceof Error ? reason.message : 'Speech could not be played. Try again.')
    } finally {
      if (pending === controller) pending = undefined
    }
  }
  watch([identity, () => session.value?.ownerId], release, { flush: 'sync' })
  onScopeDispose(release)
  return { state, error, toggle }
}
