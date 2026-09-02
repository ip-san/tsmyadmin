import type { Cell } from './schemas/cell.ts'
import { isBinaryCell } from './schemas/cell.ts'
import { CSV_NULL } from './schemas/export.ts'

/**
 * One CSV field: NULL as an unquoted `\\N`, binary as base64, quoting only when the text needs it. A text value
 * that equals the NULL marker is quoted so the import can tell the two apart (as COPY / LOAD DATA do), and so
 * is the empty string: in a one-column table it would otherwise be a blank line, which the import skips.
 */
export function csvField(cell: Cell): string {
  if (cell === null) return CSV_NULL
  const text = isBinaryCell(cell) ? cell.$bin : typeof cell === 'string' ? cell : String(cell)
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

export function parseCsvDocument(text: string, options: CsvParseOptions = {}): CsvDocument {
  const delimiter = options.delimiter ?? ','
  const input = text.startsWith('\ufeff') ? text.slice(1) : text
  const rows: string[][] = []
  const quotedRows: boolean[][] = []
  let row: string[] = []
  let quotedRow: boolean[] = []
  let field = ''
  let quoted = false
  let wasQuoted = false
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
    rows.push(row)
    quotedRows.push(quotedRow)
    row = []
    quotedRow = []
  }
  while (i < n) {
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
      field += ch
      i++
      continue
    }
    if (ch === '"' && field.length === 0) {
      quoted = true
      wasQuoted = true
      i++
      continue
    }
    if (ch === delimiter) {
      endField()
      i++
      continue
    }
    if (ch === '\r') {
      endRow()
      i += input[i + 1] === '\n' ? 2 : 1
      continue
    }
    if (ch === '\n') {
      endRow()
      i++
      continue
    }
    field += ch
    i++
  }
  if (field.length > 0 || wasQuoted || row.length > 0) endRow()
  // A trailing newline produces no extra row; a fully empty document produces none either.
  const last = rows.length - 1
  if (last >= 0 && rows[last]?.length === 1 && rows[last]?.[0] === '' && !quotedRows[last]?.[0]) {
    rows.pop()
    quotedRows.pop()
  }
  return { rows, quoted: quotedRows }
}
