import type { SpeechVoice } from '../../shared/contracts/speech.ts'

export const maxAudioBytes = 2 * 1024 * 1024
export const maxSpeechText = 240
export const miniMaxEndpoint = 'https://api.minimaxi.com/v1/t2a_v2'
export const miniMaxModel = 'speech-2.8-turbo'

export class SpeechError extends Error {
  readonly code: string
  readonly status: 400 | 404 | 408 | 429 | 502 | 503 | 504
  readonly retryAfter?: number
  constructor(code: string, message: string, status: SpeechError['status'], retryAfter?: number) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

export function synthesisRequest(text: string, voiceId: SpeechVoice, model = miniMaxModel) {
  return {
    model, text, stream: false, language_boost: 'English', output_format: 'hex',
    voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
  }
}

// The requested encoding is MPEG-1 Layer III, 128 kbps / 32 kHz. Check
// for a complete first frame, allowing a leading ID3v2 tag.
export function isMp3(bytes: Buffer) {
  if (bytes.length < 4 || bytes.length > maxAudioBytes) return false
  let offset = 0
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6, 10).some((value) => value >= 128)) return false
    for (const value of bytes.subarray(6, 10)) offset = offset * 128 + value
    offset += 10
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10
  }
  if (offset + 4 > bytes.length) return false
  const [sync, flags, rate] = bytes.subarray(offset, offset + 3)
  const bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][rate >> 4]
  const sampleRate = [44_100, 48_000, 32_000][(rate >> 2) & 3]
  return sync === 0xff && (flags & 0xfe) === 0xfa && !!bitrate && !!sampleRate
    && offset + Math.floor(144_000 * bitrate / sampleRate) + ((rate >> 1) & 1) <= bytes.length
}

const invalidAudio = () => new SpeechError('TTS_INVALID_AUDIO', 'The speech provider returned invalid audio.', 502)
const unavailable = () => new SpeechError('TTS_PROVIDER', 'The speech provider is unavailable. Try again.', 502)
const timedOut = () => new SpeechError('TTS_TIMEOUT', 'Speech generation timed out. Try again.', 504)
const throttled = () => new SpeechError('TTS_RATE_LIMIT', 'Too many speech requests. Try again shortly.', 429, 60)

async function readResponse(response: Response, signal: AbortSignal) {
  const limit = maxAudioBytes * 2 + 8192
  const reader = response.body?.getReader()
  if (!reader) throw invalidAudio()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (Number(response.headers.get('Content-Length')) > limit) throw invalidAudio()
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.length
      if (size > limit) throw invalidAudio()
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown }
    catch { throw invalidAudio() }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

export function miniMaxProvider(apiKey: string | undefined, send: typeof fetch = fetch, timeoutMs = 15_000) {
  return async (request: ReturnType<typeof synthesisRequest>, parent?: AbortSignal): Promise<Buffer> => {
    if (!apiKey) throw new SpeechError('TTS_NOT_CONFIGURED', 'MiniMax speech is not configured on the server.', 503)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
    try {
      signal.throwIfAborted()
      const response = await send(miniMaxEndpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw response.status === 429 ? throttled() : response.status === 402
          ? new SpeechError('TTS_QUOTA', 'The speech provider quota or balance is exhausted.', 503) : unavailable()
      }
      const result = await readResponse(response, signal) as {
        base_resp?: { status_code?: number }
        data?: { audio?: unknown; status?: number }
        extra_info?: { audio_format?: string; audio_size?: number }
      } | null
      const status = result?.base_resp?.status_code
      if (status === 1001) throw timedOut()
      if (status === 1002 || status === 1039) throw throttled()
      if (status === 1008) throw new SpeechError('TTS_QUOTA', 'The speech provider quota or balance is exhausted.', 503)
      if (status !== 0) throw unavailable()
      const audio = result?.data?.audio
      if (typeof audio !== 'string' || audio.length > maxAudioBytes * 2 || audio.length % 2 || !/^[\da-f]+$/i.test(audio)
        || (result?.data?.status !== undefined && result.data.status !== 2)
        || (result?.extra_info?.audio_format !== undefined && result.extra_info.audio_format !== 'mp3')) throw invalidAudio()
      const bytes = Buffer.from(audio, 'hex')
      if (!isMp3(bytes) || (result?.extra_info?.audio_size !== undefined && result.extra_info.audio_size !== bytes.length)) {
        throw invalidAudio()
      }
      return bytes
    } catch (error) {
      if (parent?.aborted) throw new SpeechError('TTS_CANCELLED', 'Speech request was cancelled.', 408)
      if (timeout.aborted) throw timedOut()
      if (error instanceof SpeechError) throw error
      throw unavailable()
    }
  }
}
