import type { Cell, Dialect } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'

/** MySQL string literal (backslash escapes are active unless NO_BACKSLASH_ESCAPES). */
export function mysqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

/** PostgreSQL string literal (standard_conforming_strings: backslash is literal). */
export function pgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function hex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex')
}

/** SQL literal for a wire cell, per dialect. Used only by the dump exporters. */
export function cellLiteral(dialect: Dialect, cell: Cell): string {
  if (cell === null) return 'NULL'
  if (isBinaryCell(cell)) return dialect === 'mysql' ? `X'${hex(cell.$bin)}'` : `'\\x${hex(cell.$bin)}'::bytea`
  // Dumps read with no cap, so a truncated cell here is a programming error, not a value to write cut.
  if (isTruncatedCell(cell)) throw new Error('truncated text cannot be written to a dump')
  switch (typeof cell) {
    case 'number':
      return Number.isFinite(cell) ? String(cell) : 'NULL'
    case 'boolean':
      return dialect === 'mysql' ? (cell ? '1' : '0') : cell ? 'TRUE' : 'FALSE'
    default:
      return dialect === 'mysql' ? mysqlLiteral(cell) : pgLiteral(cell)
  }
}
