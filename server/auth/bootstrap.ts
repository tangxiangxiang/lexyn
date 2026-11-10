import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest()

// Adapted from Nuvyn's process-local first-run setup capability.
export function createBootstrapState(explicitToken?: string, log = console.log) {
  if (explicitToken && Buffer.byteLength(explicitToken, 'utf8') < 32) {
    throw new Error('LEXYN_SETUP_TOKEN must contain at least 32 UTF-8 bytes.')
  }
  const token = explicitToken || randomBytes(32).toString('base64url')
  let expected: Buffer | undefined = digest(token)
  if (!explicitToken) log(`[lexyn] One-time setup token: ${token}`)

  return {
    verify(provided: string) {
      return !!expected && timingSafeEqual(expected, digest(provided))
    },
    markOwnerCommitted() {
      expected = undefined
    },
  }
}

export type BootstrapState = ReturnType<typeof createBootstrapState>
