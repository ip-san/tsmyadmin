import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Derives the at-rest key for stored credentials from the session secret (so one secret configures everything). */
export function deriveSessionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'tsmyadmin-session-store', 'credentials-at-rest', 32))
}

/** iv | tag | ciphertext */
export function seal(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function open(key: Buffer, sealed: Uint8Array): string {
  const buf = Buffer.from(sealed)
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('sealed payload too short')
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}
