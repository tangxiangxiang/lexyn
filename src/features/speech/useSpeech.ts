import { onScopeDispose, ref, watch } from 'vue'
import type { PreparedSpeech, SpeechSettings, SpeechSettingsUpdate, SpeechVoice } from '../../../shared/contracts/speech'
import { requestSpeech, session } from '../../api/client'

type Target = { entryId: string } | { voiceId: SpeechVoice }

export const speechSettings = {
  read: (signal?: AbortSignal) => requestSpeech<SpeechSettings>('settings', 'GET', undefined, signal),
  save: (values: SpeechSettingsUpdate) => requestSpeech<SpeechSettings>('settings', 'PUT', values),
}

export function useSpeech(target: () => Target, identity: () => string, preload: () => boolean) {
  const state = ref<'idle' | 'loading' | 'ready' | 'playing' | 'error'>('idle')
  const error = ref('')
  let pending: AbortController | undefined
  let preparation: { controller: AbortController; task: Promise<PreparedSpeech> } | undefined
  let prepared: PreparedSpeech | undefined
  let player: HTMLAudioElement | undefined
  let url: string | undefined

  function release() {
    pending?.abort()
    pending = undefined
    preparation?.controller.abort()
    preparation = undefined
    prepared = undefined
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
  function prepare() {
    if (prepared) return Promise.resolve(prepared)
    if (preparation) return preparation.task
    const controller = new AbortController()
    const source = target()
    const task = requestSpeech<PreparedSpeech>('entryId' in source ? 'prepare' : 'preview', 'POST', source, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) prepared = value
        return value
      }).finally(() => {
        if (preparation?.controller === controller) preparation = undefined
      })
    preparation = { controller, task }
    return task
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
      const { audioId, playbackRate } = await prepare()
      if (controller.signal.aborted) return
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
  watch([identity, preload, () => session.value?.ownerId], () => {
    release()
    if (!preload() || !session.value) return
    const task = prepare()
    const controller = preparation?.controller
    void task.catch((reason) => {
      if (!controller?.signal.aborted && state.value === 'idle') {
        error.value = reason instanceof Error ? reason.message : 'Speech could not be played. Try again.'
      }
    })
  }, { immediate: true })
  onScopeDispose(release)
  return { state, error, toggle }
}
