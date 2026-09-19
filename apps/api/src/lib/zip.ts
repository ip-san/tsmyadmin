import { inflateRawSync } from 'node:zlib'

/**
 * A ZIP writer that streams (an entry is compressed as it is produced, its size and checksum following it in a data
 * descriptor) and a reader for the archives it and office programs make. No ZIP64: an entry or an archive of 4 GiB
 * or more is refused rather than written wrongly.
 */

const encoder = new TextEncoder()
const LIMIT = 0xffff_ffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 of `bytes`, continuing from `crc` (a running value starts at 0). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return ~c >>> 0
}

/** Bytes of a chunk that may be text. */
export const toBytes = (chunk: string | Uint8Array): Uint8Array =>
  typeof chunk === 'string' ? encoder.encode(chunk) : chunk

/** Compresses a chunk stream (`gzip` for a .gz file, `deflate-raw` for the inside of a ZIP entry). */
export async function* compressStream(
  format: 'gzip' | 'deflate-raw',
  input: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>
): AsyncIterable<Uint8Array> {
  const stream = new CompressionStream(format)
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  // Feeding and draining run side by side: the compressor holds output back until it has input, and stops
  // taking input while its output is not read.
  const feed = (async () => {
    try {
      for await (const chunk of input) await writer.write(toBytes(chunk) as Uint8Array<ArrayBuffer>)
      await writer.close()
    } catch (err) {
      await writer.abort(err)
    }
  })()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
    finished = true
  } finally {
    // A consumer that leaves early (a client that went away) must not wait for a feeder that is blocked on
    // backpressure: cancelling the reader and aborting the writer frees it, and closes the input in turn.
    if (!finished) {
      await reader.cancel().catch(() => undefined)
      await writer.abort().catch(() => undefined)
    }
    await feed
  }
}

export interface ZipEntry {
  name: string
  /** Bytes (or text) known up front, or a stream whose length is not known until it ends. */
  data: string | Uint8Array | AsyncIterable<string | Uint8Array>
  /** Keep the bytes as they are, uncompressed (`mimetype` of an OpenDocument file must be). */
  store?: boolean
}

const dosTime = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff
const dosDate = (d: Date) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff

function view(size: number): { bytes: Uint8Array; dv: DataView } {
  const bytes = new Uint8Array(size)
  return { bytes, dv: new DataView(bytes.buffer) }
}

interface Written {
  name: Uint8Array
  method: number
  flags: number
  crc: number
  compressed: number
  size: number
  offset: number
}

/** The entries as one ZIP file, chunk by chunk. */
export async function* zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  now: Date = new Date()
): AsyncIterable<Uint8Array> {
  const written: Written[] = []
  let offset = 0
  const time = dosTime(now)
  const date = dosDate(now)
  for await (const entry of entries) {
    const name = encoder.encode(entry.name)
    const known = typeof entry.data === 'string' || entry.data instanceof Uint8Array
    const stored = entry.store === true
    // Bit 11: names are UTF-8. Bit 3: the sizes come after the data (a stream's are not known before).
    const flags = 0x0800 | (known ? 0 : 0x0008)
    const method = stored ? 0 : 8
    const start = offset
    let crc = 0
    let size = 0
    let compressed = 0
    const bytes = known ? toBytes(entry.data as string | Uint8Array) : null
    let deflated: Uint8Array | null = null
    if (bytes) {
      crc = crc32(bytes)
      size = bytes.length
      if (stored) deflated = bytes
      else {
        const parts: Uint8Array[] = []
        for await (const part of compressStream('deflate-raw', [bytes])) parts.push(part)
        deflated = Buffer.concat(parts)
      }
      compressed = deflated.length
    }
    const head = view(30 + name.length)
    head.dv.setUint32(0, 0x0403_4b50, true)
    head.dv.setUint16(4, 20, true)
    head.dv.setUint16(6, flags, true)
    head.dv.setUint16(8, method, true)
    head.dv.setUint16(10, time, true)
    head.dv.setUint16(12, date, true)
    head.dv.setUint32(14, known ? crc : 0, true)
    head.dv.setUint32(18, known ? compressed : 0, true)
    head.dv.setUint32(22, known ? size : 0, true)
    head.dv.setUint16(26, name.length, true)
    head.bytes.set(name, 30)
    yield head.bytes
    offset += head.bytes.length
    if (deflated) {
      yield deflated
      offset += deflated.length
    } else {
      // Counted on the way in, checksummed as it goes.
      const counted = (async function* () {
        for await (const chunk of entry.data as AsyncIterable<string | Uint8Array>) {
          const b = toBytes(chunk)
          crc = crc32(b, crc)
          size += b.length
          yield b
        }
      })()
      for await (const part of compressStream('deflate-raw', counted)) {
        compressed += part.length
        offset += part.length
        yield part
      }
      const tail = view(16)
      tail.dv.setUint32(0, 0x0807_4b50, true)
      tail.dv.setUint32(4, crc, true)
      tail.dv.setUint32(8, compressed, true)
      tail.dv.setUint32(12, size, true)
      yield tail.bytes
      offset += tail.bytes.length
    }
    if (compressed >= LIMIT || size >= LIMIT || offset >= LIMIT)
      throw new Error('A ZIP entry of 4 GiB or more is not supported')
    written.push({ name, method, flags, crc, compressed, size, offset: start })
  }
  const directoryStart = offset
  for (const w of written) {
    const record = view(46 + w.name.length)
    record.dv.setUint32(0, 0x0201_4b50, true)
    record.dv.setUint16(4, 20, true)
    record.dv.setUint16(6, 20, true)
    record.dv.setUint16(8, w.flags, true)
    record.dv.setUint16(10, w.method, true)
    record.dv.setUint16(12, time, true)
    record.dv.setUint16(14, date, true)
    record.dv.setUint32(16, w.crc, true)
    record.dv.setUint32(20, w.compressed, true)
    record.dv.setUint32(24, w.size, true)
    record.dv.setUint16(28, w.name.length, true)
    record.dv.setUint32(42, w.offset, true)
    record.bytes.set(w.name, 46)
    yield record.bytes
    offset += record.bytes.length
  }
  const end = view(22)
  end.dv.setUint32(0, 0x0605_4b50, true)
  end.dv.setUint16(8, written.length, true)
  end.dv.setUint16(10, written.length, true)
  end.dv.setUint32(12, offset - directoryStart, true)
  end.dv.setUint32(16, directoryStart, true)
  if (written.length > 0xffff || offset >= LIMIT) throw new Error('A ZIP archive this large is not supported')
  yield end.bytes
}

/** What a compressed upload may unpack to (a zip bomb of a few kilobytes must not fill the memory). */
export const MAX_UNPACKED = 256 * 1024 * 1024

/** An entry (or a run of them) inflates past the size the caller allows. */
export class UnpackLimitError extends Error {}

export interface ZipFile {
  name: string
  /** The entry's bytes, checked against its checksum; `max` refuses one that inflates past it (UnpackLimitError). */
  bytes: (max?: number) => Uint8Array
}

/** A ZIP file's entries (directories left out). Throws for anything that is not a plain ZIP. */
export function readZip(archive: Uint8Array): ZipFile[] {
  const dv = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  // The end-of-central-directory record is within the last 64 KiB + 22 bytes (a comment may follow it).
  let end = -1
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x0605_4b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('Not a ZIP file')
  const count = dv.getUint16(end + 10, true)
  let at = dv.getUint32(end + 16, true)
  const files: ZipFile[] = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(at, true) !== 0x0201_4b50) throw new Error('Damaged ZIP directory')
    const method = dv.getUint16(at + 10, true)
    const crc = dv.getUint32(at + 16, true)
    const compressed = dv.getUint32(at + 20, true)
    const size = dv.getUint32(at + 24, true)
    const nameLength = dv.getUint16(at + 28, true)
    const extraLength = dv.getUint16(at + 30, true)
    const commentLength = dv.getUint16(at + 32, true)
    const local = dv.getUint32(at + 42, true)
    const name = new TextDecoder('utf-8').decode(archive.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    files.push({
      name,
      bytes: (max?: number) => {
        const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
        const raw = archive.subarray(dataStart, dataStart + compressed)
        let out: Uint8Array
        if (method === 0) {
          if (max !== undefined && raw.length > max)
            throw new UnpackLimitError(`The entry ${name} is larger than ${max} bytes`)
          out = raw
        } else if (method === 8) {
          try {
            out = new Uint8Array(inflateRawSync(raw, max === undefined ? {} : { maxOutputLength: max }))
          } catch (err) {
            const tooBig = err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
            if (tooBig) throw new UnpackLimitError(`The entry ${name} inflates to more than ${max} bytes`)
            throw err
          }
        } else throw new Error(`ZIP compression method ${method} is not supported`)
        if (out.length !== size || crc32(out) !== crc) throw new Error(`ZIP entry ${name} is damaged`)
        return out
      },
    })
  }
  return files
}
