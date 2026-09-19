import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compressStream, crc32, readZip, type ZipEntry, zipStream } from './zip.ts'

const collect = async (parts: AsyncIterable<Uint8Array>) => Buffer.concat(await Array.fromAsync(parts))

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf4_3926)
  })

  it('continues from a running value', () => {
    const a = new TextEncoder().encode('1234')
    const b = new TextEncoder().encode('56789')
    expect(crc32(b, crc32(a))).toBe(0xcbf4_3926)
  })
})

describe('compressStream', () => {
  it('makes a gzip file that reads back whole', async () => {
    const text = 'hello, world\n'.repeat(1000)
    const zipped = await collect(
      compressStream('gzip', chunks('hello, world\n'.repeat(500), 'hello, world\n'.repeat(500)))
    )
    expect(zipped.length).toBeLessThan(text.length)
    expect(gunzipSync(zipped).toString('utf8')).toBe(text)
  })
})

describe('zipStream and readZip', () => {
  it('writes known and streamed entries, stored or deflated, and reads them back checked', async () => {
    const entries: ZipEntry[] = [
      { name: 'mimetype', data: 'application/x-test', store: true },
      { name: 'dir/日本語.txt', data: 'こんにちは' },
      { name: 'streamed.txt', data: chunks('abc\n'.repeat(2000), 'tail') },
      { name: 'bytes.bin', data: new Uint8Array([0, 1, 2, 255]) },
    ]
    const archive = await collect(zipStream(entries))
    const files = readZip(new Uint8Array(archive))
    expect(files.map((f) => f.name)).toEqual(['mimetype', 'dir/日本語.txt', 'streamed.txt', 'bytes.bin'])
    const text = (n: string) => new TextDecoder().decode(files.find((f) => f.name === n)?.bytes())
    expect(text('mimetype')).toBe('application/x-test')
    expect(text('dir/日本語.txt')).toBe('こんにちは')
    expect(text('streamed.txt')).toBe(`${'abc\n'.repeat(2000)}tail`)
    expect([...(files.find((f) => f.name === 'bytes.bin')?.bytes() ?? [])]).toEqual([0, 1, 2, 255])
    // The stored entry really is stored: its text is in the archive as it is, right after its header.
    expect(archive.toString('latin1')).toContain('mimetypeapplication/x-test')
  })

  it('reads an empty archive, and refuses a file that is not one or has a damaged entry', async () => {
    expect(readZip(new Uint8Array(await collect(zipStream([]))))).toEqual([])
    expect(() => readZip(new TextEncoder().encode('not a zip'))).toThrow(/Not a ZIP/)
    const archive = new Uint8Array(
      await collect(zipStream([{ name: 'a.txt', data: 'payload payload payload', store: true }]))
    )
    const at = Buffer.from(archive).indexOf('payload')
    archive[at] = 0x58
    expect(() => readZip(archive)[0]?.bytes()).toThrow(/damaged/)
  })
})
