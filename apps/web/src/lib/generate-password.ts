/** Characters that survive being pasted into a shell, a URL and a SQL string without a second thought. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/**
 * A random password of `length` characters from an alphabet with no look-alikes (no 0 / O, 1 / l / I). Drawn from
 * the browser's cryptographic generator, and without modulo bias: a value that would favour the first characters
 * is thrown away and drawn again.
 */
export function generatePassword(length = 16, random: (n: number) => Uint32Array = randomValues): string {
  const limit = Math.floor(0x1_0000_0000 / ALPHABET.length) * ALPHABET.length
  let out = ''
  while (out.length < length) {
    for (const value of random(length)) {
      if (value < limit && out.length < length) out += ALPHABET.charAt(value % ALPHABET.length)
    }
  }
  return out
}

function randomValues(n: number): Uint32Array {
  return crypto.getRandomValues(new Uint32Array(n))
}
