/** Conversion between driver values and the wire `Cell`, and how much of a large value a read keeps. */
import type { Cell } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell, MAX_BINARY_BYTES, MAX_TEXT_CHARS } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'

/** Per-query options handed to the driver layer. */
export interface QueryOptions {
  /** Bytes kept of each binary value (default MAX_BINARY_BYTES for display; Infinity for exports). */
  binaryLimit?: number
  /**
   * Characters kept of each text value. Unlimited by default: catalog reads (a view definition, a routine body,
   * SHOW CREATE TABLE) must arrive whole. Only the rows shown to the user (browse pages, console results) pass
   * DISPLAY.
   */
  textLimit?: number
}

/** Export reads: whole values, whatever their size. */
export const UNCAPPED: QueryOptions = { binaryLimit: Number.POSITIVE_INFINITY, textLimit: Number.POSITIVE_INFINITY }
/** Rows rendered on a page: a multi-megabyte TEXT / JSON cell travels as its head plus its length. */
export const DISPLAY: QueryOptions = { textLimit: MAX_TEXT_CHARS }

/** Converts a wire Cell into a driver parameter. */
export function toDbValue(cell: Cell): unknown {
  if (isBinaryCell(cell)) return Buffer.from(cell.$bin, 'base64')
  // The schemas already reject it at the API; this guards adapter-internal callers (row keys built from a page).
  if (isTruncatedCell(cell)) throw new AdapterError('VALIDATION', 'a truncated text value cannot be written back')
  return cell
}

/** Binary cell for the wire, cut at `limit` bytes (display) or kept whole (`Infinity`, exports). */
export function bufferToCell(buf: Uint8Array, limit = MAX_BINARY_BYTES): Cell {
  const slice = buf.byteLength > limit ? buf.subarray(0, limit) : buf
  return { $bin: Buffer.from(slice).toString('base64') }
}

/**
 * Converts a driver value into a wire Cell (both drivers are configured to return BIGINT/DECIMAL/dates as
 * strings already; binaries arrive as Buffers, JSON as text or objects).
 */
export function driverValueToCell(value: unknown, options: QueryOptions = {}): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return bufferToCell(value, options.binaryLimit)
  switch (typeof value) {
    case 'string': {
      const limit = options.textLimit ?? Number.POSITIVE_INFINITY
      if (value.length <= limit) return value
      // Cut between code points: a high surrogate at the edge would leave a lone half of a character.
      const cut = value.charCodeAt(limit - 1)
      const end = cut >= 0xd800 && cut <= 0xdbff ? limit - 1 : limit
      return { $text: value.slice(0, end), length: value.length }
    }
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    default:
      return JSON.stringify(value)
  }
}
