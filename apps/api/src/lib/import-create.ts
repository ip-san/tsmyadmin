import type { ColumnSpec, Dialect } from '@tsmyadmin/shared'
import type { RowCell } from './import-rows.ts'

/**
 * The columns of a table made from a file: a name for each, and the narrowest type every value of it fits.
 * Read from all the rows (a column that looks like integers for a thousand rows and then holds text must not be an
 * INT). Nothing here is a guess the data can contradict: a value that does not fit the type it was given would
 * have been text.
 */

const INT = /^-?(?:0|[1-9]\d*)$/
const DECIMAL = /^-?(?:0|[1-9]\d*)\.\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/
const INT32 = 2_147_483_647n
const INT64 = 9_223_372_036_854_775_807n
/** Digits a DECIMAL may carry: past this the text is safer than a column that could reject a later value. */
const MAX_PRECISION = 38

export type InferredType = 'int' | 'bigint' | 'decimal' | 'date' | 'datetime' | 'varchar' | 'text'

interface Seen {
  values: number
  ints: boolean
  decimals: boolean
  dates: boolean
  datetimes: boolean
  int32: boolean
  int64: boolean
  maxInt: number
  maxScale: number
  maxLength: number
}

function scan(rows: readonly (readonly RowCell[])[], column: number): Seen {
  const seen: Seen = {
    values: 0,
    ints: true,
    decimals: true,
    dates: true,
    datetimes: true,
    int32: true,
    int64: true,
    maxInt: 0,
    maxScale: 0,
    maxLength: 0,
  }
  for (const row of rows) {
    const cell = row[column]
    if (cell === null || cell === undefined || typeof cell !== 'string') {
      if (cell !== null && cell !== undefined) {
        // Bytes: only a text column can hold them.
        seen.ints = seen.decimals = seen.dates = seen.datetimes = false
        seen.values++
        seen.maxLength = Math.max(seen.maxLength, cell.base64.length)
      }
      continue
    }
    seen.values++
    seen.maxLength = Math.max(seen.maxLength, [...cell].length)
    const isInt = INT.test(cell)
    const isDecimal = DECIMAL.test(cell)
    if (!isInt) seen.ints = false
    if (!isInt && !isDecimal) seen.decimals = false
    if (!DATE.test(cell)) seen.dates = false
    if (!DATETIME.test(cell)) seen.datetimes = false
    if (isInt) {
      const n = BigInt(cell)
      if (n > INT32 || n < -INT32 - 1n) seen.int32 = false
      if (n > INT64 || n < -INT64 - 1n) seen.int64 = false
    }
    if (isInt || isDecimal) {
      const [whole = '', fraction = ''] = cell.replace('-', '').split('.')
      seen.maxInt = Math.max(seen.maxInt, whole.length)
      seen.maxScale = Math.max(seen.maxScale, fraction.length)
    }
  }
  return seen
}

/** The type of a column and its SQL, for the dialect. */
export function inferType(
  rows: readonly (readonly RowCell[])[],
  column: number,
  dialect: Dialect
): { type: InferredType; dataType: string } {
  const s = scan(rows, column)
  const text = () =>
    s.maxLength <= 255
      ? { type: 'varchar' as const, dataType: 'VARCHAR(255)' }
      : { type: 'text' as const, dataType: dialect === 'mysql' ? (s.maxLength > 65_535 ? 'LONGTEXT' : 'TEXT') : 'TEXT' }
  if (s.values === 0) return { type: 'varchar', dataType: 'VARCHAR(255)' }
  if (s.ints && s.int32) return { type: 'int', dataType: 'INT' }
  if (s.ints && s.int64) return { type: 'bigint', dataType: 'BIGINT' }
  if (s.decimals && !s.ints) {
    const precision = s.maxInt + s.maxScale
    if (precision <= MAX_PRECISION && s.maxScale > 0)
      return { type: 'decimal', dataType: `DECIMAL(${precision},${s.maxScale})` }
  }
  if (s.dates) return { type: 'date', dataType: 'DATE' }
  if (s.datetimes) return { type: 'datetime', dataType: dialect === 'mysql' ? 'DATETIME' : 'TIMESTAMP' }
  return text()
}

/** A name safe to use as a column: not empty, trimmed, and not the same as an earlier one (`name`, `name_2`…). */
export function columnNames(header: readonly string[] | null, width: number): string[] {
  const used = new Set<string>()
  return Array.from({ length: width }, (_, i) => {
    const base = (header?.[i] ?? '').trim().slice(0, 60) || `col${i + 1}`
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 56)}_${n}`
    used.add(name.toLowerCase())
    return name
  })
}

/** Column specs for a createTable operation: every column nullable (a file says nothing about keys). */
export function inferColumns(
  names: readonly string[],
  rows: readonly (readonly RowCell[])[],
  dialect: Dialect
): ColumnSpec[] {
  return names.map((name, i) => ({
    name,
    dataType: inferType(rows, i, dialect).dataType,
    nullable: true,
    default: null,
    autoIncrement: false,
    comment: null,
    collation: null,
    onUpdate: null,
    check: null,
    generated: null,
  }))
}
