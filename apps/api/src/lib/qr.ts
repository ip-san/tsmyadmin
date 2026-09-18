import { encode } from 'uqr'

/**
 * A QR code as rows of '1' (dark) and '0', for the page to draw — the secret stays in this process rather than
 * going to a third-party service, and the page draws plain rectangles instead of inserting markup. No quiet zone:
 * the page adds it. Error correction M, as authenticator apps expect from a screen.
 */
export function qrRows(text: string): string[] {
  return encode(text, { border: 0, ecc: 'M' }).data.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}
