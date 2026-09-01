/** RFC 4180 CSV parsing (quotes, escaped quotes, CR/LF/CRLF, optional BOM). */
export interface CsvParseOptions {
  delimiter?: string
}

export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ','
  const input = text.startsWith('﻿') ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = input.length
  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
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
  if (field.length > 0 || row.length > 0) endRow()
  // A trailing newline produces no extra row; a fully empty document produces none either.
  return rows.filter((r, idx) => !(idx === rows.length - 1 && r.length === 1 && r[0] === ''))
}
