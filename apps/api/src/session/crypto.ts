import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Derives the at-rest key for stored credentials from the session secret (so one secret configures everything). */
export function deriveSessionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'tsmyadmin-session-store', 'credentials-at-rest', 32))
}

/**
 * The row a sealed payload belongs to, mixed into the authentication tag. Without it, someone able to write to
 * the file (but unable to decrypt it) could copy another row's payload over their own and have it open: their
 * session would then run with the victim's credentials. Binding the ciphertext to the row makes that fail.
 */
export function rowAad(table: string, id: string): Buffer {
  return Buffer.from(`tsmyadmin:${table}:${id}`, 'utf8')
}

/** iv | tag | ciphertext, authenticated against `aad` (see rowAad). */
export function seal(key: Buffer, plaintext: string, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function decrypt(key: Buffer, sealed: Uint8Array, aad: Buffer | null): string {
  const buf = Buffer.from(sealed)
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('sealed payload too short')
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, iv)
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** Opens a payload sealed for exactly this row; anything else fails, including the same payload from another. */
export function open(key: Buffer, sealed: Uint8Array, aad: Buffer): string {
  return decrypt(key, sealed, aad)
}

/**
 * Opens a payload written before payloads were bound to their row. Only the store's format migration and its
 * secret-fingerprint probe may use this — everything else must go through `open`, so a binding cannot be lost
 * by forgetting to pass one.
 */
export function openLegacy(key: Buffer, sealed: Uint8Array): string {
  return decrypt(key, sealed, null)
}
