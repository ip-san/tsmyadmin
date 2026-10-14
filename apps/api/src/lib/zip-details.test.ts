import { describe, expect, it, vi } from 'vitest'
import { crc32, readZip, UnpackLimitError, zipStream } from './zip.ts'

/**
 * The bytes of the archives it writes, field by field, and what the reader makes of the ones it is given: comments,
 * extra fields, directories, methods and sizes. An archive is read by programs this code has never met, so the layout
 * is the contract (found as surviving mutants; see `bun run mutation`).
 */

const NOW = new Date(2024, 4, 17, 13, 45, 30)
const DOS_TIME = (13 << 11) | (45 << 5) | 15
const DOS_DATE = ((2024 - 1980) << 9) | (5 << 5) | 17
const utf8 = (text: string) => new TextEncoder().encode(text)

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of stream) parts.push(part)
  return Buffer.concat(parts)
}
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p
}

describe('the archive it writes', () => {
  it('writes a known, deflated entry as a local header, its data, a directory record and an end record', async () => {
    const zip = await collect(zipStream([{ name: 'a.txt', data: 'hello hello hello hello' }], NOW))
    const dv = view(zip)
    // Local header.
    expect(dv.getUint32(0, true)).toBe(0x0403_4b50)
    expect(dv.getUint16(4, true)).toBe(20)
    expect(dv.getUint16(6, true)).toBe(0x0800)
    expect(dv.getUint16(8, true)).toBe(8)
    expect(dv.getUint16(10, true)).toBe(DOS_TIME)
    expect(dv.getUint16(12, true)).toBe(DOS_DATE)
    expect(dv.getUint32(14, true)).toBe(crc32(utf8('hello hello hello hello')))
    expect(dv.getUint32(22, true)).toBe(23)
    const compressed = dv.getUint32(18, true)
    expect(compressed).toBeGreaterThan(0)
    expect(compressed).toBeLessThan(23)
    expect(dv.getUint16(26, true)).toBe(5)
    expect(dv.getUint16(28, true)).toBe(0)
    expect(new TextDecoder().decode(zip.subarray(30, 35))).toBe('a.txt')
    // Central directory, after the data.
    const dir = 35 + compressed
    expect(dv.getUint32(dir, true)).toBe(0x0201_4b50)
    expect(dv.getUint16(dir + 4, true)).toBe(20)
    expect(dv.getUint16(dir + 6, true)).toBe(20)
    expect(dv.getUint16(dir + 8, true)).toBe(0x0800)
    expect(dv.getUint16(dir + 10, true)).toBe(8)
    expect(dv.getUint16(dir + 12, true)).toBe(DOS_TIME)
    expect(dv.getUint16(dir + 14, true)).toBe(DOS_DATE)
    expect(dv.getUint32(dir + 16, true)).toBe(crc32(utf8('hello hello hello hello')))
    expect(dv.getUint32(dir + 20, true)).toBe(compressed)
    expect(dv.getUint32(dir + 24, true)).toBe(23)
    expect(dv.getUint16(dir + 28, true)).toBe(5)
    expect(dv.getUint16(dir + 30, true)).toBe(0)
    expect(dv.getUint16(dir + 32, true)).toBe(0)
    expect(dv.getUint32(dir + 42, true)).toBe(0)
    expect(new TextDecoder().decode(zip.subarray(dir + 46, dir + 51))).toBe('a.txt')
    // End record.
    const end = dir + 51
    expect(zip.length).toBe(end + 22)
    expect(dv.getUint32(end, true)).toBe(0x0605_4b50)
    expect(dv.getUint16(end + 8, true)).toBe(1)
    expect(dv.getUint16(end + 10, true)).toBe(1)
    expect(dv.getUint32(end + 12, true)).toBe(51)
    expect(dv.getUint32(end + 16, true)).toBe(dir)
  })

  it('keeps a stored entry as it is, and names the method', async () => {
    const zip = await collect(zipStream([{ name: 'mimetype', data: 'application/x', store: true }], NOW))
    const dv = view(zip)
    expect(dv.getUint16(8, true)).toBe(0)
    expect(dv.getUint32(18, true)).toBe(13)
    expect(dv.getUint32(22, true)).toBe(13)
    expect(new TextDecoder().decode(zip.subarray(38, 51))).toBe('application/x')
    expect(Buffer.from(readZip(zip)[0]?.bytes() ?? []).toString()).toBe('application/x')
  })

  it('writes a streamed entry with its sizes after the data, in a descriptor, and zeros in the header', async () => {
    const zip = await collect(zipStream([{ name: 's.txt', data: chunks('abc', 'def') }], NOW))
    const dv = view(zip)
    expect(dv.getUint16(6, true)).toBe(0x0808)
    expect(dv.getUint32(14, true)).toBe(0)
    expect(dv.getUint32(18, true)).toBe(0)
    expect(dv.getUint32(22, true)).toBe(0)
    const entry = readZip(zip)[0]
    expect(entry?.bytes()).toEqual(utf8('abcdef'))
    // The descriptor sits right before the directory and carries the checksum and both sizes.
    const dirAt = dv.getUint32(zip.length - 22 + 16, true)
    expect(dv.getUint32(dirAt - 16, true)).toBe(0x0807_4b50)
    expect(dv.getUint32(dirAt - 12, true)).toBe(crc32(utf8('abcdef')))
    expect(dv.getUint32(dirAt - 4, true)).toBe(6)
    expect(dv.getUint32(dirAt - 8, true)).toBe(dv.getUint32(dirAt + 20, true))
    expect(dv.getUint16(dirAt + 8, true)).toBe(0x0808)
    expect(dv.getUint32(dirAt + 16, true)).toBe(crc32(utf8('abcdef')))
  })

  it('records where each entry starts and the names in UTF-8, several entries in the order given', async () => {
    const zip = await collect(
      zipStream(
        [
          { name: 'one.txt', data: '1' },
          { name: 'é/二.txt', data: chunks('2') },
          { name: 'three', data: new Uint8Array([3, 3, 3]), store: true },
        ],
        NOW
      )
    )
    const dv = view(zip)
    const endAt = zip.length - 22
    expect(dv.getUint16(endAt + 8, true)).toBe(3)
    expect(dv.getUint16(endAt + 10, true)).toBe(3)
    expect(dv.getUint32(endAt + 12, true)).toBe(endAt - dv.getUint32(endAt + 16, true))
    const files = readZip(zip)
    expect(files.map((f) => f.name)).toEqual(['one.txt', 'é/二.txt', 'three'])
    expect(files.map((f) => Buffer.from(f.bytes()).toString())).toEqual(['1', '2', '\u0003\u0003\u0003'])
    // Each directory record points at the header of its own entry.
    let at = dv.getUint32(endAt + 16, true)
    const offsets: number[] = []
    for (let n = 0; n < 3; n++) {
      offsets.push(dv.getUint32(at + 42, true))
      at += 46 + dv.getUint16(at + 28, true)
    }
    expect(offsets[0]).toBe(0)
    for (const o of offsets) expect(dv.getUint32(o, true)).toBe(0x0403_4b50)
    expect(offsets[1]).toBeGreaterThan(offsets[0] as number)
    expect(offsets[2]).toBeGreaterThan(offsets[1] as number)
    // The name length is in bytes, not characters.
    expect(dv.getUint16((offsets[1] as number) + 26, true)).toBe(utf8('é/二.txt').length)
  })

  it('writes an archive of no entries as an end record alone', async () => {
    const zip = await collect(zipStream([], NOW))
    expect(zip.length).toBe(22)
    expect(view(zip).getUint16(8, true)).toBe(0)
    expect(readZip(zip)).toEqual([])
  })

  it('dates an entry with the time it is given, in DOS form, and the time now when none is', async () => {
    const early = await collect(zipStream([{ name: 'x', data: '' }], new Date(1980, 0, 1, 0, 0, 0)))
    expect(view(early).getUint16(10, true)).toBe(0)
    expect(view(early).getUint16(12, true)).toBe((0 << 9) | (1 << 5) | 1)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Local time, as DOS dates are: midday keeps the day the same in every zone.
      vi.setSystemTime(new Date(2031, 5, 15, 12, 30, 10))
      const stamped = await collect(zipStream([{ name: 'x', data: '' }]))
      expect(view(stamped).getUint16(10, true)).toBe((12 << 11) | (30 << 5) | 5)
      expect(view(stamped).getUint16(12, true)).toBe(((2031 - 1980) << 9) | (6 << 5) | 15)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A ZIP built by hand, so a field the writer never sets (an extra field, a comment) can be there. */
function handmade(opts: {
  extraLocal?: number
  extraCentral?: number
  comment?: number
  archiveComment?: number
  method?: number
  sizeOverride?: number
}) {
  const name = utf8('f.txt')
  const data = utf8('payload')
  const crc = crc32(data)
  const local = new Uint8Array(30 + name.length + (opts.extraLocal ?? 0) + data.length)
  const lv = view(local)
  lv.setUint32(0, 0x0403_4b50, true)
  lv.setUint16(8, opts.method ?? 0, true)
  lv.setUint16(26, name.length, true)
  lv.setUint16(28, opts.extraLocal ?? 0, true)
  local.set(name, 30)
  local.set(data, 30 + name.length + (opts.extraLocal ?? 0))
  const central = new Uint8Array(46 + name.length + (opts.extraCentral ?? 0) + (opts.comment ?? 0))
  const cv = view(central)
  cv.setUint32(0, 0x0201_4b50, true)
  cv.setUint16(10, opts.method ?? 0, true)
  cv.setUint32(16, crc, true)
  cv.setUint32(20, data.length, true)
  cv.setUint32(24, opts.sizeOverride ?? data.length, true)
  cv.setUint16(28, name.length, true)
  cv.setUint16(30, opts.extraCentral ?? 0, true)
  cv.setUint16(32, opts.comment ?? 0, true)
  cv.setUint32(42, 0, true)
  central.set(name, 46)
  const end = new Uint8Array(22 + (opts.archiveComment ?? 0))
  const ev = view(end)
  ev.setUint32(0, 0x0605_4b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, local.length, true)
  ev.setUint16(20, opts.archiveComment ?? 0, true)
  return Buffer.concat([local, central, end])
}

describe('readZip', () => {
  it('reads the data past an extra field in the local header and skips the extra field and comment of the directory', () => {
    const files = readZip(handmade({ extraLocal: 7, extraCentral: 5, comment: 3 }))
    expect(files.map((f) => f.name)).toEqual(['f.txt'])
    expect(Buffer.from(files[0]?.bytes() ?? []).toString()).toBe('payload')
  })

  it('finds the end record under a comment, up to 65535 bytes of it, and no further', () => {
    expect(readZip(handmade({ archiveComment: 100 }))).toHaveLength(1)
    expect(readZip(handmade({ archiveComment: 0xffff }))).toHaveLength(1)
    expect(() => readZip(handmade({ archiveComment: 0x10000 }))).toThrow('Not a ZIP file')
  })

  it('refuses what is not a ZIP, and a directory that is damaged', () => {
    expect(() => readZip(utf8('plain text, no zip here at all'))).toThrow('Not a ZIP file')
    expect(() => readZip(new Uint8Array(0))).toThrow('Not a ZIP file')
    expect(() => readZip(new Uint8Array(21))).toThrow('Not a ZIP file')
    const zip = handmade({})
    const broken = Buffer.from(zip)
    const dirAt = view(broken).getUint32(broken.length - 22 + 16, true)
    broken[dirAt] = 0
    expect(() => readZip(broken)).toThrow('Damaged ZIP directory')
  })

  it('leaves out the directories and reads the files in the order of the directory', async () => {
    const zip = await collect(
      zipStream(
        [
          { name: 'top/', data: '' },
          { name: 'top/a.txt', data: 'A' },
          { name: 'top/sub/', data: '' },
          { name: 'b.txt', data: 'B' },
        ],
        NOW
      )
    )
    expect(readZip(zip).map((f) => f.name)).toEqual(['top/a.txt', 'b.txt'])
  })

  it('refuses a method it does not know, and an entry whose size or checksum is not what the directory says', () => {
    expect(() => readZip(handmade({ method: 9 }))[0]?.bytes()).toThrow('ZIP compression method 9 is not supported')
    expect(() => readZip(handmade({ method: 1 }))[0]?.bytes()).toThrow('ZIP compression method 1 is not supported')
    expect(() => readZip(handmade({ sizeOverride: 8 }))[0]?.bytes()).toThrow('ZIP entry f.txt is damaged')
    expect(Buffer.from(readZip(handmade({ sizeOverride: 7 }))[0]?.bytes() ?? []).toString()).toBe('payload')
  })

  it('refuses an entry past the size allowed, exactly one byte over, stored or deflated', async () => {
    const stored = readZip(handmade({}))[0]
    expect(Buffer.from(stored?.bytes(7) ?? []).toString()).toBe('payload')
    expect(Buffer.from(stored?.bytes(100) ?? []).toString()).toBe('payload')
    expect(() => stored?.bytes(6)).toThrow(UnpackLimitError)
    expect(() => stored?.bytes(6)).toThrow('The entry f.txt is larger than 6 bytes')
    const zip = await collect(zipStream([{ name: 'big.txt', data: 'x'.repeat(1000) }], NOW))
    const deflated = readZip(zip)[0]
    expect(deflated?.bytes(1000)?.length).toBe(1000)
    expect(deflated?.bytes()?.length).toBe(1000)
    expect(() => deflated?.bytes(999)).toThrow(UnpackLimitError)
    expect(() => deflated?.bytes(999)).toThrow('The entry big.txt inflates to more than 999 bytes')
  })

  it('does not take another failure of the inflater for a size limit', () => {
    const zip = handmade({ method: 8 })
    const entry = readZip(zip)[0]
    expect(() => entry?.bytes()).toThrow()
    expect(() => entry?.bytes()).not.toThrow(UnpackLimitError)
  })
})

describe('crc32', () => {
  it('matches the known values, for text and for bytes in more than one piece', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf4_3926)
    expect(crc32(new Uint8Array(0))).toBe(0)
    expect(crc32(utf8('6789'), crc32(utf8('12345')))).toBe(0xcbf4_3926)
    expect(crc32(new Uint8Array([0]))).toBe(0xd202_ef8d)
  })
})

/** An archive of `count` identical stored entries, each directory record carrying an extra field and a comment. */
function repeated(count: number, extra: number, comment: number) {
  const name = utf8('f.txt')
  const data = utf8('payload')
  const local = new Uint8Array(30 + name.length + data.length)
  const lv = view(local)
  lv.setUint32(0, 0x0403_4b50, true)
  lv.setUint16(26, name.length, true)
  local.set(name, 30)
  local.set(data, 30 + name.length)
  const record = new Uint8Array(46 + name.length + extra + comment)
  const rv = view(record)
  rv.setUint32(0, 0x0201_4b50, true)
  rv.setUint32(16, crc32(data), true)
  rv.setUint32(20, data.length, true)
  rv.setUint32(24, data.length, true)
  rv.setUint16(28, name.length, true)
  rv.setUint16(30, extra, true)
  rv.setUint16(32, comment, true)
  record.set(name, 46)
  const end = new Uint8Array(22)
  const ev = view(end)
  ev.setUint32(0, 0x0605_4b50, true)
  ev.setUint16(8, count, true)
  ev.setUint16(10, count, true)
  ev.setUint32(12, record.length * count, true)
  ev.setUint32(16, local.length, true)
  return Buffer.concat([local, ...Array.from({ length: count }, () => record), end])
}

describe('readZip: stepping through the directory', () => {
  it('steps over the name, the extra field and the comment of each record, whatever their sizes, to reach the next', () => {
    for (const [extra, comment] of [
      [0, 0],
      [5, 3],
      [300, 0],
      [0, 258],
      [260, 515],
    ] as const) {
      const files = readZip(repeated(3, extra, comment))
      expect(
        files.map((f) => f.name),
        `${extra}/${comment}`
      ).toEqual(['f.txt', 'f.txt', 'f.txt'])
      expect(Buffer.from(files[2]?.bytes() ?? []).toString()).toBe('payload')
    }
  })
})

describe('the size recorded for a streamed entry', () => {
  it('is the length of the compressed bytes between its header and its descriptor', async () => {
    const zip = await collect(zipStream([{ name: 's.txt', data: chunks('abc'.repeat(50), 'def'.repeat(50)) }], NOW))
    const dv = view(zip)
    const dirAt = dv.getUint32(zip.length - 22 + 16, true)
    expect(dv.getUint32(dirAt - 8, true)).toBe(dirAt - 16 - 35)
    expect(dv.getUint32(dirAt - 4, true)).toBe(300)
  })
})
