// Adapted from Nuvyn's AES-256-GCM provider credential storage.
// Format: base64 IV, auth tag, and ciphertext, separated by colons.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export function encryptApiKey(plaintext: string, key: Buffer) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join(':')
}

export function decryptApiKey(blob: string, key: Buffer) {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted credential.')
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'))
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted credential.')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
