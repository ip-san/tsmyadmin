import type { Cell } from './schemas/cell.ts'
import { isBinaryCell, isTruncatedCell } from './schemas/cell.ts'
import { CSV_NULL } from './schemas/export.ts'

/**
 * One CSV field: NULL as an unquoted `\\N`, binary as base64, quoting only when the text needs it. A text value
 * that equals the NULL marker is quoted so the import can tell the two apart (as COPY / LOAD DATA do), and so
 * is the empty string: in a one-column table it would otherwise be a blank line, which the import skips.
 */
export function csvField(
  cell: Cell,
  neutralise = false,
  delimiter = ',',
  style: { quoteAll?: boolean; stripEol?: boolean } = {}
): string {
  if (cell === null) return CSV_NULL
  // A cut value must never land in a file that looks complete; callers check with isTruncatedCell first.
  if (isTruncatedCell(cell)) throw new Error('truncated text cannot be written to CSV')
  const raw = isBinaryCell(cell) ? cell.$bin : typeof cell === 'string' ? cell : String(cell)
  // Line breaks read as a space, for a program that takes one record per line (the value changes: opt-in).
  const flat = style.stripEol ? raw.replace(/\r\n|\r|\n/g, ' ') : raw
  const text = neutralise ? neutraliseFormula(flat) : flat
  // NULL stays the bare marker even when everything else is quoted: that is what tells it from the text \N.
  const needsQuotes =
    style.quoteAll === true || /["\r\n]/.test(text) || text.includes(delimiter) || text === CSV_NULL || text === ''
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Leading characters that make Excel / LibreOffice / Sheets treat a cell as a formula. Prefixing them with an
 * apostrophe stops that, at the cost of changing the value — hence opt-in: the export → import round trip must
 * stay lossless by default.
 */
const FORMULA_START = /^[=+\-@\t\r]/

/** The value with a leading apostrophe when a spreadsheet would run it as a formula; otherwise unchanged. */
export function neutraliseFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}

/** Header + rows as CRLF-terminated CSV (the format the table export and the SQL console download share). */
export function toCsv(columns: string[], rows: Cell[][], neutralise = false): string {
  const field = (c: Cell) => csvField(c, neutralise)
  const lines = [columns.map(field).join(','), ...rows.map((row) => row.map(field).join(','))]
  return `${lines.join('\r\n')}\r\n`
}

/** RFC 4180 CSV parsing (quotes, escaped quotes, CR/LF/CRLF, optional BOM). */
export interface CsvParseOptions {
  delimiter?: string
  /** The character that encloses a field (default `"`). */
  quote?: string
  /**
   * The character that escapes the next one inside a quoted field. Left at the quote character (the default) a
   * doubled quote is a quote (RFC 4180); a backslash makes `\"` and `\\` literal.
   */
  escape?: string
  /**
   * What ends a record: any line break (the default, `auto`: LF, CRLF and CR alike), or only this one — then the
   * other line-break characters are part of the value, as they are in a file that only ever ends records with one.
   */
  lineEnd?: 'auto' | 'lf' | 'crlf' | 'cr'
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
  const quoteChar = options.quote ?? '"'
  const escapeChar = options.escape ?? quoteChar
  const input = text.startsWith('\ufeff') ? text.slice(1) : text
  const terminator =
    options.lineEnd === 'lf' ? '\n' : options.lineEnd === 'crlf' ? '\r\n' : options.lineEnd === 'cr' ? '\r' : null
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
      // A separate escape character makes the next one literal, whatever it is (a quote, the escape itself…).
      if (escapeChar !== quoteChar && ch === escapeChar && i + 1 < n) {
        const next = input[i + 1] as string
        if (next === '\n') line++
        field += next
        i += 2
        continue
      }
      if (ch === quoteChar) {
        if (escapeChar === quoteChar && input[i + 1] === quoteChar) {
          field += quoteChar
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
    if (ch === quoteChar && field.length === 0) {
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
    if (terminator !== null) {
      if (input.startsWith(terminator, i)) {
        line++
        i += terminator.length
        endRow()
        continue
      }
      // Not this file's record end: a line break here is part of the value.
      if (ch === '\n') line++
      field += ch
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
