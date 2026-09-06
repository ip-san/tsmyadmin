import type { Cell } from './schemas/cell.ts'
import { isBinaryCell, isTruncatedCell } from './schemas/cell.ts'
import { CSV_NULL } from './schemas/export.ts'

/**
 * One CSV field: NULL as an unquoted `\\N`, binary as base64, quoting only when the text needs it. A text value
 * that equals the NULL marker is quoted so the import can tell the two apart (as COPY / LOAD DATA do), and so
 * is the empty string: in a one-column table it would otherwise be a blank line, which the import skips.
 */
export function csvField(cell: Cell): string {
  if (cell === null) return CSV_NULL
  const text = isBinaryCell(cell)
    ? cell.$bin
    : isTruncatedCell(cell)
      ? cell.$text
      : typeof cell === 'string'
        ? cell
        : String(cell)
  return /[",\r\n]/.test(text) || text === CSV_NULL || text === '' ? `"${text.replaceAll('"', '""')}"` : text
}

/** Header + rows as CRLF-terminated CSV (the format the table export and the SQL console download share). */
export function toCsv(columns: string[], rows: Cell[][]): string {
  const lines = [columns.map(csvField).join(','), ...rows.map((row) => row.map(csvField).join(','))]
  return `${lines.join('\r\n')}\r\n`
}

/** RFC 4180 CSV parsing (quotes, escaped quotes, CR/LF/CRLF, optional BOM). */
export interface CsvParseOptions {
  delimiter?: string
}

export interface CsvDocument {
  rows: string[][]
  /** Per field, whether it was written in quotes (a quoted `\\N` is the text, an unquoted one is NULL). */
  quoted: boolean[][]
}

export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  return parseCsvDocument(text, options).rows
}

/** One parsed record: its fields, which of them were quoted, and the 1-based line it starts on. */
export interface CsvRecord {
  fields: string[]
  quoted: boolean[]
  line: number
}

/** A quote opened on `line` was never closed: the rest of the file would silently become one field. */
export class CsvParseError extends Error {
  readonly line: number
  constructor(line: number) {
    super(`Unterminated quoted field starting on line ${line}`)
    this.name = 'CsvParseError'
    this.line = line
  }
}

export function parseCsvDocument(text: string, options: CsvParseOptions = {}): CsvDocument {
  const rows: string[][] = []
  const quoted: boolean[][] = []
  for (const r of parseCsvRecords(text, options)) {
    rows.push(r.fields)
    quoted.push(r.quoted)
  }
  return { rows, quoted }
}

/** Records one at a time, so a large file is held once (as text) rather than twice (text plus every row). */
export function* parseCsvRecords(text: string, options: CsvParseOptions = {}): Generator<CsvRecord> {
  const delimiter = options.delimiter ?? ','
  const input = text.startsWith('\ufeff') ? text.slice(1) : text
  let row: string[] = []
  let quotedRow: boolean[] = []
  let field = ''
  let quoted = false
  let wasQuoted = false
  let quoteLine = 0
  let line = 1
  let rowLine = 1
  let pending: CsvRecord | null = null
  let i = 0
  const n = input.length
  const endField = () => {
    row.push(field)
    quotedRow.push(wasQuoted)
    field = ''
    wasQuoted = false
  }
  const endRow = () => {
    endField()
    pending = { fields: row, quoted: quotedRow, line: rowLine }
    row = []
    quotedRow = []
    rowLine = line
  }
  while (i < n) {
    if (pending) {
      const r: CsvRecord = pending
      pending = null
      yield r
    }
    const ch = input[i] as string
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      if (ch === '\n') line++
      field += ch
      i++
      continue
    }
    if (ch === '"' && field.length === 0) {
      quoted = true
      wasQuoted = true
      quoteLine = line
      i++
      continue
    }
    if (ch === delimiter) {
      endField()
      i++
      continue
    }
    if (ch === '\r') {
      line++
      i += input[i + 1] === '\n' ? 2 : 1
      endRow()
      continue
    }
    if (ch === '\n') {
      line++
      i++
      endRow()
      continue
    }
    field += ch
    i++
  }
  if (quoted) throw new CsvParseError(quoteLine)
  if (field.length > 0 || wasQuoted || row.length > 0) endRow()
  if (pending) {
    // A trailing newline produces no extra row; a fully empty document produces none either.
    const r: CsvRecord = pending
    if (!(r.fields.length === 1 && r.fields[0] === '' && !r.quoted[0])) yield r
  }
}
