import type { Dialect } from './schemas/dialect.ts'

/** A cell as the import reads it: text, NULL, or bytes as base64. */
export type RowCell = string | null | { base64: string }

/**
 * The columns of a table made from a file: a name for each, and the narrowest type every value of it fits.
 * Read from all the rows (a column that looks like integers for a thousand rows and then holds text must not be an
 * INT). Dates are checked as calendar dates and the sizes against what the server holds, so the data fits the type
 * it was given; a file can still hold a value only the server can judge, which then fails the load (the table made
 * for it is dropped again).
 */

const INT = /^-?(?:0|[1-9]\d*)$/
const DECIMAL = /^-?(?:0|[1-9]\d*)\.\d+$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/
const INT32 = 2_147_483_647n
const INT64 = 9_223_372_036_854_775_807n
/** Digits a DECIMAL may carry: past this the text is safer than a column that could reject a later value. */
const MAX_PRECISION = 38
/** MySQL's largest DECIMAL scale. */
const MAX_SCALE = 30

/** A real calendar date in the range both servers keep (MySQL DATETIME: years 1000 to 9999). */
function calendarDate(year: string, month: string, day: string): boolean {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (y < 1000 || m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const isDate = (text: string) => {
  const m = DATE.exec(text)
  return m !== null && calendarDate(m[1] as string, m[2] as string, m[3] as string)
}

/** The fraction digits of a valid date-time, or -1 when the text is not one. */
function dateTimeFraction(text: string): number {
  const m = DATETIME.exec(text)
  if (!m || !calendarDate(m[1] as string, m[2] as string, m[3] as string)) return -1
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return -1
  return (m[7] ?? '').length
}

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
  maxBytes: number
  maxFraction: number
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
    maxBytes: 0,
    maxFraction: 0,
  }
  for (const row of rows) {
    const cell = row[column]
    if (cell === null || cell === undefined || typeof cell !== 'string') {
      if (cell !== null && cell !== undefined) {
        // Bytes: only a text column can hold them.
        seen.ints = seen.decimals = seen.dates = seen.datetimes = false
        seen.values++
        seen.maxLength = Math.max(seen.maxLength, cell.base64.length)
        seen.maxBytes = Math.max(seen.maxBytes, cell.base64.length)
      }
      continue
    }
    seen.values++
    seen.maxLength = Math.max(seen.maxLength, [...cell].length)
    seen.maxBytes = Math.max(seen.maxBytes, new TextEncoder().encode(cell).length)
    const isInt = INT.test(cell)
    const isDecimal = DECIMAL.test(cell)
    if (!isInt) seen.ints = false
    if (!isInt && !isDecimal) seen.decimals = false
    if (!isDate(cell)) seen.dates = false
    const fraction = dateTimeFraction(cell)
    if (fraction < 0) seen.datetimes = false
    else seen.maxFraction = Math.max(seen.maxFraction, fraction)
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
      : {
          type: 'text' as const,
          // MySQL sizes TEXT in bytes (a multi-byte character takes up to four).
          dataType:
            dialect === 'mysql'
              ? s.maxBytes > 16_777_215
                ? 'LONGTEXT'
                : s.maxBytes > 65_535
                  ? 'MEDIUMTEXT'
                  : 'TEXT'
              : 'TEXT',
        }
  if (s.values === 0) return { type: 'varchar', dataType: 'VARCHAR(255)' }
  if (s.ints && s.int32) return { type: 'int', dataType: 'INT' }
  if (s.ints && s.int64) return { type: 'bigint', dataType: 'BIGINT' }
  if (s.decimals && !s.ints) {
    const precision = s.maxInt + s.maxScale
    if (precision <= MAX_PRECISION && s.maxScale > 0 && s.maxScale <= MAX_SCALE)
      return { type: 'decimal', dataType: `DECIMAL(${precision},${s.maxScale})` }
  }
  if (s.dates) return { type: 'date', dataType: 'DATE' }
  if (s.datetimes) {
    // MySQL's DATETIME rounds away fractional seconds unless it is told to keep them.
    const mysqlType = s.maxFraction > 0 ? `DATETIME(${s.maxFraction})` : 'DATETIME'
    return { type: 'datetime', dataType: dialect === 'mysql' ? mysqlType : 'TIMESTAMP' }
  }
  return text()
}
