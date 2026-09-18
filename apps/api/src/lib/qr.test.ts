import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import { qrRows } from './qr.ts'

/** The 7×7 finder pattern every QR code has in three corners. */
const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']

describe('qrRows', () => {
  it('is a square QR symbol with its three finder patterns, and no quiet zone', () => {
    const rows = qrRows('otpauth://totp/tsmyadmin:root%40db%3A3306?secret=JBSWY3DPEHPK3PXP&issuer=tsmyadmin')
    const size = rows.length
    // Versions are 21, 25, 29, … modules wide.
    expect((size - 17) % 4).toBe(0)
    for (const row of rows) expect(row).toMatch(new RegExp(`^[01]{${size}}$`))
    for (let i = 0; i < 7; i++) {
      expect(rows[i]?.slice(0, 7), `top-left ${i}`).toBe(FINDER[i])
      expect(rows[i]?.slice(size - 7), `top-right ${i}`).toBe(FINDER[i])
      expect(rows[size - 7 + i]?.slice(0, 7), `bottom-left ${i}`).toBe(FINDER[i])
    }
  })

  it('reads back as the same URI with an independent decoder', () => {
    // Drawn the way the page draws it: dark on white, with a four-module quiet zone.
    const text =
      'otpauth://totp/tsmyadmin:alice%40db.internal%3A3306?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=tsmyadmin&algorithm=SHA1&digits=6&period=30'
    const rows = qrRows(text)
    const quiet = 4
    const scale = 4
    const px = (rows.length + quiet * 2) * scale
    const pixels = new Uint8ClampedArray(px * px * 4).fill(255)
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '1') continue
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4
            pixels.fill(0, i, i + 3)
          }
      }
    })
    expect(jsQR(pixels, px, px)?.data).toBe(text)
  })

  it('grows with the text, as a longer URI needs a larger version', () => {
    expect(qrRows(`x${'A'.repeat(200)}`).length).toBeGreaterThan(qrRows('x').length)
  })
})
