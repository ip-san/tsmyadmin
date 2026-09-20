import type { RowCell } from '@tsmyadmin/shared'
import { MAX_UNPACKED, readZip, UnpackLimitError } from './zip.ts'

/**
 * Rows read from a file that is not CSV: an OpenDocument spreadsheet, an XML export (this tool's or phpMyAdmin's),
 * or a MediaWiki table. Each comes out as the same thing — an optional header, then rows of text (or NULL) — so the
 * importer treats them all alike. XML is read by a tokenizer that never expands an entity it was not given, so a
 * hostile file cannot pull in another file or grow without bound.
 */

/** A value of a cell: text, NULL, or bytes as base64 (an XML export carries binary that way). */
export type { RowCell }

export interface SourceRow {
  /** 1-based line of the file (ODS: the row number of the sheet). */
  line: number
  cells: RowCell[]
}

export class RowsParseError extends Error {
  constructor(
    readonly kind: 'NO_SHEET' | 'PARSE',
    message: string,
    readonly params: Record<string, string> = {}
  ) {
    super(message)
    this.name = 'RowsParseError'
  }
}

/** Safety caps: a spreadsheet can claim a million empty rows, or a hostile one a repeat count in the billions. */
const MAX_REPEAT = 100_000
const MAX_CELLS_PER_ROW = 5000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
/** `&amp;` and its like, and numeric references. Any other entity is left as written (never expanded). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] ?? whole
  })
}

type XmlEvent =
  | { type: 'start'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'end'; name: string }
  | { type: 'text'; text: string }

/** An opening or closing tag with its attributes, matched at one position (sticky), so a failed match costs one tag. */
const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * The events of an XML document, in order. Comments, processing instructions and a DOCTYPE are skipped. A hand-written
 * scan (`indexOf` for each terminator) rather than one big pattern: an unterminated `<!--` repeated a hundred thousand
 * times would make a lazy pattern rescan the rest of the file each time.
 */
function* xmlEvents(xml: string): Generator<XmlEvent> {
  const skipTo = (from: number, end: string) => {
    const at = xml.indexOf(end, from)
    return at < 0 ? xml.length : at + end.length
  }
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i)
      const end = next < 0 ? xml.length : next
      yield { type: 'text', text: decodeEntities(xml.slice(i, end)) }
      i = end
    } else if (xml.startsWith('<!--', i)) i = skipTo(i + 4, '-->')
    else if (xml.startsWith('<?', i)) i = skipTo(i + 2, '?>')
    else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      yield { type: 'text', text: xml.slice(i + 9, end < 0 ? xml.length : end) }
      i = end < 0 ? xml.length : end + 3
    } else if (xml.startsWith('<!', i)) i = skipTo(i + 2, '>')
    else {
      TAG.lastIndex = i
      const m = TAG.exec(xml)
      if (!m) {
        i++
        continue
      }
      const name = m[2] as string
      if (m[1] === '/') yield { type: 'end', name }
      else {
        const attrs: Record<string, string> = {}
        for (const a of (m[3] ?? '').matchAll(ATTR)) attrs[a[1] as string] = decodeEntities(a[2] ?? a[3] ?? '')
        yield { type: 'start', name, attrs, selfClosing: m[4] === '/' }
        if (m[4] === '/') yield { type: 'end', name }
      }
      i = TAG.lastIndex
    }
  }
}

const trimRow = (cells: RowCell[]) => {
  let end = cells.length
  while (end > 0 && cells[end - 1] === null) end--
  return cells.slice(0, end)
}

/** How a file's rows are read where a format leaves a choice. */
export interface ReadOptions {
  /** A blank row is not a row of the file (default). Off: it is one with no values. */
  skipBlank?: boolean
  /** ODS: read a percentage, currency amount or date as it is shown instead of as the number / date it holds. */
  odsText?: { percentage?: boolean; currency?: boolean; date?: boolean }
}

/** The sheets of an OpenDocument spreadsheet, each as rows of text (a value's own text, dates and numbers included). */
export function readOds(bytes: Uint8Array, options: ReadOptions = {}): { name: string; rows: SourceRow[] }[] {
  const skipBlank = options.skipBlank !== false
  const shown = options.odsText ?? {}
  let content: string
  try {
    const file = readZip(bytes).find((f) => f.name === 'content.xml')
    if (!file) throw new Error('content.xml is missing')
    content = new TextDecoder().decode(file.bytes(MAX_UNPACKED))
  } catch (err) {
    if (err instanceof UnpackLimitError) throw err
    throw new RowsParseError('PARSE', err instanceof Error ? err.message : String(err), {
      message: err instanceof Error ? err.message : String(err),
    })
  }
  const sheets: { name: string; rows: SourceRow[] }[] = []
  let sheet: { name: string; rows: SourceRow[] } | null = null
  let rowNumber = 0
  let row: RowCell[] | null = null
  let rowRepeat = 1
  let cell: { value: RowCell; repeat: number; typed: boolean } | null = null
  let paragraphs: string[] = []
  let inParagraph = false
  let current = ''
  const finishRow = () => {
    if (!sheet || !row) return
    const cells = trimRow(row)
    const empty = cells.length === 0
    const repeats = Math.min(rowRepeat, MAX_REPEAT)
    // A run of empty rows (a sheet is padded to a million) is not data. Kept when asked, between the rows that have
    // values: the padding after the last of them is trimmed below.
    if (!empty || !skipBlank) for (let r = 0; r < repeats; r++) sheet.rows.push({ line: rowNumber + r + 1, cells })
    rowNumber += rowRepeat
    row = null
  }
  for (const e of xmlEvents(content)) {
    if (e.type === 'start') {
      switch (e.name) {
        case 'table:table':
          sheet = { name: e.attrs['table:name'] ?? `Sheet${sheets.length + 1}`, rows: [] }
          sheets.push(sheet)
          rowNumber = 0
          break
        case 'table:table-row':
          row = []
          rowRepeat = Number(e.attrs['table:number-rows-repeated'] ?? 1) || 1
          break
        case 'table:table-cell':
        case 'table:covered-table-cell': {
          const type = e.attrs['office:value-type']
          // As it is shown: the cell's own paragraphs, read like a string's.
          const asShown =
            (type === 'percentage' && shown.percentage === true) ||
            (type === 'currency' && shown.currency === true) ||
            (type === 'date' && shown.date === true)
          const value = asShown
            ? null
            : type === 'float' || type === 'percentage' || type === 'currency'
              ? (e.attrs['office:value'] ?? null)
              : type === 'date'
                ? (e.attrs['office:date-value'] ?? null)
                : type === 'time'
                  ? (e.attrs['office:time-value'] ?? null)
                  : type === 'boolean'
                    ? (e.attrs['office:boolean-value'] ?? null)
                    : type === 'string' && e.attrs['office:string-value'] !== undefined
                      ? e.attrs['office:string-value']
                      : null
          cell = {
            value,
            repeat: Math.min(Number(e.attrs['table:number-columns-repeated'] ?? 1) || 1, MAX_CELLS_PER_ROW),
            typed: (type === 'string' && value === null) || asShown,
          }
          paragraphs = []
          break
        }
        case 'text:p':
        case 'text:h':
          inParagraph = true
          current = ''
          break
        case 'text:s':
          if (inParagraph) current += ' '.repeat(Math.min(Number(e.attrs['text:c'] ?? 1) || 1, 1000))
          break
        case 'text:tab':
          if (inParagraph) current += '\t'
          break
        case 'text:line-break':
          if (inParagraph) current += '\n'
          break
      }
    } else if (e.type === 'text') {
      if (inParagraph) current += e.text
    } else {
      switch (e.name) {
        case 'text:p':
        case 'text:h':
          if (inParagraph) paragraphs.push(current)
          inParagraph = false
          break
        case 'table:table-cell':
        case 'table:covered-table-cell': {
          if (cell && row) {
            // A string cell's value is its paragraphs; an empty one is NULL, as an unfilled cell is.
            const text = cell.typed ? paragraphs.join('\n') : cell.value
            const value: RowCell = text === '' ? null : text
            // A run of empty cells is expanded (a gap in the middle is columns); the padding at the end is trimmed
            // with the row.
            for (let n = 0; n < Math.max(cell.repeat, 1); n++) {
              if (row.length < MAX_CELLS_PER_ROW) row.push(value)
            }
          }
          cell = null
          break
        }
        case 'table:table-row':
          finishRow()
          break
      }
    }
  }
  // Empty rows kept: not the padding after the last row that holds a value.
  if (!skipBlank) {
    for (const s of sheets) {
      while (s.rows.length > 0 && (s.rows.at(-1)?.cells.length ?? 0) === 0) s.rows.pop()
    }
  }
  return sheets
}

/** Which of the named things is meant: by name, or by 1-based number, or the first. */
export function pickSheet<T extends { name: string }>(sheets: T[], wanted: string | undefined): T {
  if (sheets.length === 0) throw new RowsParseError('NO_SHEET', 'The file holds no table', { sheet: wanted ?? '' })
  if (wanted === undefined || wanted.trim() === '') return sheets[0] as T
  const byName = sheets.find((s) => s.name === wanted)
  const number = /^\d+$/.test(wanted.trim()) ? sheets[Number(wanted) - 1] : undefined
  const found = byName ?? number
  if (!found) throw new RowsParseError('NO_SHEET', `No sheet or table named ${wanted}`, { sheet: wanted })
  return found
}

/**
 * Tables of an XML export. Both forms are read: this tool's (`<table name><row><column name>…`) and
 * phpMyAdmin's (`<table name><column name>…` — one `<table>` element per row). `null="true"` is NULL and
 * `encoding="base64"` carries bytes.
 */
export function readXmlTables(
  xml: string,
  options: ReadOptions = {}
): { name: string; header: string[]; rows: SourceRow[] }[] {
  const skipBlank = options.skipBlank !== false
  const tables = new Map<string, { header: string[]; rows: { line: number; cells: Map<string, RowCell> }[] }>()
  let table = ''
  let direct: Map<string, RowCell> | null = null
  let rowCells: Map<string, RowCell> | null = null
  let column: { name: string; isNull: boolean; base64: boolean; text: string } | null = null
  let count = 0
  // This tool's export may hold a table's structure (its columns as `<column>` elements): not rows.
  let inStructure = false
  const emit = (cells: Map<string, RowCell>) => {
    if (cells.size === 0 && skipBlank) return
    const t = tables.get(table) ?? { header: [], rows: [] }
    tables.set(table, t)
    for (const name of cells.keys()) if (!t.header.includes(name)) t.header.push(name)
    count++
    t.rows.push({ line: count, cells })
  }
  for (const e of xmlEvents(xml)) {
    if (e.type === 'start') {
      if (e.name === 'table') {
        table = e.attrs.name ?? `table${tables.size + 1}`
        direct = new Map()
      } else if (e.name === 'structure') inStructure = true
      else if (e.name === 'row') rowCells = new Map()
      else if (e.name === 'column' && e.attrs.name !== undefined && !inStructure)
        column = {
          name: e.attrs.name,
          isNull: e.attrs.null === 'true',
          base64: e.attrs.encoding === 'base64',
          text: '',
        }
    } else if (e.type === 'text') {
      if (column) column.text += e.text
    } else if (e.name === 'structure') inStructure = false
    else if (e.name === 'column' && column) {
      const target = rowCells ?? direct
      target?.set(column.name, column.isNull ? null : column.base64 ? { base64: column.text.trim() } : column.text)
      column = null
    } else if (e.name === 'row' && rowCells) {
      emit(rowCells)
      rowCells = null
    } else if (e.name === 'table') {
      // A `<table>` that holds `<row>` elements has no columns of its own: only phpMyAdmin's form does.
      if (direct && direct.size > 0) emit(direct)
      direct = null
    }
  }
  // A row that lacks a column the table has elsewhere is NULL there: the header is complete only at the end.
  return [...tables.entries()].map(([name, t]) => ({
    name,
    header: t.header,
    rows: t.rows.map((r) => ({ line: r.line, cells: t.header.map((h) => r.cells.get(h) ?? null) })),
  }))
}

const WIKI_ATTRIBUTES = /^\s*(?:[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'|]+)\s*)+$/
const wikiText = (raw: string): RowCell => {
  const text = decodeEntities(raw.trim().replace(/<br\s*\/?>/gi, '\n'))
  return text === "''NULL''" ? null : text
}

/** A cell as written after its `|` / `!`: the text, without the `style="…" |` a wiki may put before it. */
function wikiCell(part: string): string {
  const bar = part.indexOf('|')
  return bar > 0 && WIKI_ATTRIBUTES.test(part.slice(0, bar)) ? part.slice(bar + 1) : part
}

/** The tables of MediaWiki markup: `{|` … `|}`, rows by `|-`, header cells `!`, cells `|` (or `||` on one line). */
export function readWikiTables(
  text: string,
  options: ReadOptions = {}
): { name: string; header: string[] | null; rows: SourceRow[] }[] {
  const skipBlank = options.skipBlank !== false
  const tables: { name: string; header: string[] | null; rows: SourceRow[] }[] = []
  let table: { name: string; header: string[] | null; rows: SourceRow[] } | null = null
  let row: RowCell[] | null = null
  let headerRow: string[] | null = null
  let rowLine = 0
  const finish = () => {
    if (!table) return
    if (headerRow && !table.header) table.header = headerRow
    else if (row && (row.length > 0 || !skipBlank)) table.rows.push({ line: rowLine, cells: row })
    row = null
    headerRow = null
  }
  const lines = text.split(/\r\n|\r|\n/)
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd()
    if (line.startsWith('{|')) {
      table = { name: `table${tables.length + 1}`, header: null, rows: [] }
      tables.push(table)
      row = null
      headerRow = null
    } else if (!table) continue
    else if (line.startsWith('|}')) {
      finish()
      table = null
    } else if (line.startsWith('|+')) table.name = String(wikiText(line.slice(2)) ?? table.name)
    else if (line.startsWith('|-')) {
      finish()
      row = []
      rowLine = i + 1
    } else if (line.startsWith('!')) {
      headerRow = [
        ...(headerRow ?? []),
        ...line
          .slice(1)
          .split('!!')
          .map((p) => String(wikiText(wikiCell(p)) ?? '')),
      ]
      row ??= []
      rowLine ||= i + 1
    } else if (line.startsWith('|')) {
      row ??= []
      if (rowLine === 0 || row.length === 0) rowLine = i + 1
      for (const p of line.slice(1).split('||')) row.push(wikiText(wikiCell(p)))
    } else if (row && row.length > 0 && line !== '') {
      // A cell's text goes on over several lines.
      const last = row.at(-1)
      row[row.length - 1] = typeof last === 'string' ? `${last}\n${wikiText(line) as string}` : wikiText(line)
    }
  }
  return tables
}
