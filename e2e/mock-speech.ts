import type { Page } from '@playwright/test'

export function silentMp3() {
  // MPEG-1 Layer III, 128 kbps, 32 kHz, mono, empty granules.
  const frame = Buffer.alloc(576)
  frame.set([0xff, 0xfb, 0x98, 0xc4])
  return Buffer.concat(Array.from({ length: 10 }, () => frame))
}

export function mockSpeechResponse() {
  return Response.json({ base_resp: { status_code: 0 }, data: { audio: silentMp3().toString('hex'), status: 2 } })
}

declare global {
  interface Window { lexynAudio: { plays: { url: string; rate: number }[]; pauses: number; revoked: string[] } }
}

export async function trackPlayback(page: Page) {
  await page.addInitScript(() => {
    window.lexynAudio = { plays: [], pauses: 0, revoked: [] }
    const state = window.lexynAudio
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url) => { state.revoked.push(url); revoke(url) }
    HTMLMediaElement.prototype.play = async function () {
      state.plays.push({ url: this.src, rate: this.playbackRate })
    }
    HTMLMediaElement.prototype.pause = function () { state.pauses++ }
  })
}
