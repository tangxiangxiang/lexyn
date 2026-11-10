import { expect, test, vi } from 'vitest'
import { defaultSpeechVoice } from '../../shared/contracts/speech.ts'
import { mockSpeechResponse, silentMp3 } from '../../e2e/mock-speech.ts'
import { isMp3, maxAudioBytes, miniMaxEndpoint, miniMaxProvider, synthesisRequest } from './provider.ts'

const request = synthesisRequest('US', defaultSpeechVoice)

test('sends only the fixed MiniMax request and decodes validated MP3 bytes', async () => {
  const send = vi.fn<typeof fetch>(async () => mockSpeechResponse())
  expect(await miniMaxProvider('mock-key', send)(request)).toEqual(silentMp3())
  expect(send).toHaveBeenCalledWith(miniMaxEndpoint, expect.objectContaining({
    method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer mock-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'speech-2.8-turbo', text: 'US', stream: false, language_boost: 'English', output_format: 'hex',
      voice_setting: { voice_id: defaultSpeechVoice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 } }),
  }))
  expect(isMp3(Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 2, 0, 0]), silentMp3()]))).toBe(true)
  expect(isMp3(Buffer.from([0xff, 0xfb, 0x98, 0xc4]))).toBe(false)
})

test.each([
  [() => new Response('sensitive upstream error', { status: 502 }), 'TTS_PROVIDER'],
  [() => new Response(null, { status: 429 }), 'TTS_RATE_LIMIT'],
  [() => Response.json({ base_resp: { status_code: 1004 } }), 'TTS_PROVIDER'],
  [() => Response.json({ base_resp: { status_code: 1008 } }), 'TTS_QUOTA'],
  [() => Response.json({ base_resp: { status_code: 0 }, data: { audio: '00gg' } }), 'TTS_INVALID_AUDIO'],
  [() => Response.json({ base_resp: { status_code: 0 }, data: { audio: '00010203' } }), 'TTS_INVALID_AUDIO'],
  [() => new Response('x'.repeat(maxAudioBytes * 2 + 8193)), 'TTS_INVALID_AUDIO'],
])('rejects invalid or unsuccessful provider responses (%#)', async (reply, code) => {
  await expect(miniMaxProvider('mock-key', async () => reply())(request)).rejects.toMatchObject({ code })
})

test('times out a stalled response body and supports caller abort', async () => {
  const send: typeof fetch = async () => new Response(new ReadableStream())
  await expect(miniMaxProvider('mock-key', send, 10)(request)).rejects.toMatchObject({ code: 'TTS_TIMEOUT' })
  const controller = new AbortController()
  const pending = miniMaxProvider('mock-key', send)(request, controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'TTS_CANCELLED' })
})
