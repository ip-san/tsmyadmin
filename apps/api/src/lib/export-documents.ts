import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, Namespace } from '@tsmyadmin/shared'
import { EXPORT_BATCH_SIZE, isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'

/**
 * Exports meant to be read by people (LaTeX, Texy!, MediaWiki, HTML, and the spreadsheet / document files in
 * export-office.ts): NULL is told from an empty string, and a binary value is shown by its size, since none of these
 * can carry the bytes. They are not for restoring a table.
 */

const ITER_OPTS = { batchSize: EXPORT_BATCH_SIZE }

/** A value's text; null for NULL. A cut text is refused: a file must not look complete while shortened. */
export function cellText(cell: Cell): string | null {
  if (cell === null) return null
  if (isBinaryCell(cell)) return `(binary, ${Buffer.from(cell.$bin, 'base64').length} bytes)`
  if (isTruncatedCell(cell)) throw new Error('truncated text cannot be written to an export')
  return typeof cell === 'string' ? cell : String(cell)
}

/** One table's rows in batches, with its column names — an empty table yields its columns once. */
async function* tableRows(
  adapter: DatabaseAdapter,
  ns: Namespace,
  table: string
): AsyncIterable<{ columns: string[]; rows: Cell[][] }> {
  let seen = false
  for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
    seen = true
    yield { columns: b.columns.map((c) => c.name), rows: b.rows }
  }
  if (!seen) {
    const schema = await adapter.describeTable(ns, table)
    yield { columns: schema.columns.map((c) => c.name), rows: [] }
  }
}

/** What a document export holds of each table: its structure (the columns), its data, or both. */
export interface DocOptions {
  structure: boolean
  data: boolean
  /** LaTeX: a caption over each table, and a `\\label` for it. */
  latexCaption?: boolean
  latexLabel?: boolean
}

/** The choices of a request as a document export reads them. */
export const docOptions = (q: {
  structure: string
  data: string
  latexCaption?: string
  latexLabel?: string
}): DocOptions => ({
  structure: q.structure === '1',
  data: q.data === '1',
  latexCaption: q.latexCaption !== '0',
  latexLabel: q.latexLabel === '1',
})

/** The default of a document export written without a request: the data, as before. */
export const DATA_ONLY: DocOptions = { structure: false, data: true, latexCaption: true, latexLabel: false }

const STRUCTURE_COLUMNS = ['Column', 'Type', 'Null', 'Default', 'Key', 'Extra', 'Comment']

/** A table's columns as rows of text: name, type, whether NULL is allowed, default, key, extra and comment. */
export async function structureRows(adapter: DatabaseAdapter, ns: Namespace, table: string): Promise<Cell[][]> {
  const schema = await adapter.describeTable(ns, table)
  const keyOf = (name: string): string => {
    if (schema.primaryKey.includes(name)) return 'PRI'
    if (schema.indexes.some((i) => i.unique && i.columns[0] === name)) return 'UNI'
    return schema.indexes.some((i) => i.columns.includes(name)) ? 'MUL' : ''
  }
  return schema.columns.map((c) => [
    c.name,
    c.dataType,
    c.nullable ? 'YES' : 'NO',
    c.default,
    keyOf(c.name),
    c.extra,
    c.comment ?? '',
  ])
}

/** A table drawn on its own in a document: a title, the column names and the rows in batches. */
export interface Section {
  title: string
  batches: () => AsyncIterable<{ columns: string[]; rows: Cell[][] }>
}

/**
 * The parts one table makes in a document: its structure and/or its data, each drawn as a table of its own. With both
 * the titles say which is which.
 */
export function tableSections(adapter: DatabaseAdapter, ns: Namespace, table: string, o: DocOptions): Section[] {
  const both = o.structure && o.data
  const out: Section[] = []
  if (o.structure) {
    out.push({
      title: both ? `${table} (structure)` : table,
      batches: async function* () {
        yield { columns: STRUCTURE_COLUMNS, rows: await structureRows(adapter, ns, table) }
      },
    })
  }
  if (o.data) {
    out.push({ title: both ? `${table} (data)` : table, batches: () => tableRows(adapter, ns, table) })
  }
  return out
}

const LATEX: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
}
const latexEscape = (s: string) => s.replace(/[\\&%$#_{}~^]/g, (c) => LATEX[c] ?? c).replace(/\r\n|\r|\n/g, ' ')

/** A LaTeX document with one longtable per table (compile with XeLaTeX or LuaLaTeX for non-Latin text). */
export async function* latexBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY
): AsyncIterable<string> {
  yield `% tsmyadmin LaTeX export\n% Database: ${ns.database.replace(/[\r\n]/g, ' ')}\n`
  yield '\\documentclass{article}\n\\usepackage{longtable}\n\\usepackage[margin=1.5cm,landscape]{geometry}\n\\begin{document}\n'
  for (const [n, sec] of tables.flatMap((table) => tableSections(adapter, ns, table, o)).entries()) {
    let opened = false
    for await (const { columns, rows } of sec.batches()) {
      if (!opened) {
        yield `\n\\begin{longtable}{|${columns.map(() => 'l|').join('')}}\n`
        if (o.latexCaption !== false && o.latexLabel) {
          // A caption is what a label attaches to: `\\ref{tbl:1:users}` then names this table's number.
          const key = `tbl:${n + 1}:${sec.title.replace(/[^A-Za-z0-9]+/g, '_')}`
          yield `\\hline \\caption{${latexEscape(sec.title)}}\\label{${key}} \\\\ \\hline\n`
        } else if (o.latexCaption !== false) {
          yield `\\hline \\multicolumn{${columns.length}}{|c|}{\\textbf{${latexEscape(sec.title)}}} \\\\ \\hline\n`
        } else yield '\\hline\n'
        yield `${columns.map((c) => `\\textbf{${latexEscape(c)}}`).join(' & ')} \\\\ \\hline \\endhead\n`
        opened = true
      }
      yield rows
        .map((row) => {
          const cells = row.map((c) => {
            const text = cellText(c)
            return text === null ? '\\textit{NULL}' : latexEscape(text)
          })
          return `${cells.join(' & ')} \\\\ \\hline\n`
        })
        .join('')
    }
    yield '\\end{longtable}\n'
  }
  yield '\n\\end{document}\n'
}

const texyCell = (c: Cell) => (cellText(c) ?? 'NULL').replace(/\r\n|\r|\n/g, ' ').replaceAll('|', '&#124;')

/** Texy! tables: a heading and a `|`-ruled table per table. */
export async function* texyBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY
): AsyncIterable<string> {
  for (const [t, sec] of tables.flatMap((table) => tableSections(adapter, ns, table, o)).entries()) {
    yield `${t > 0 ? '\n' : ''}===${sec.title.replace(/[\r\n]/g, ' ')}\n\n`
    let header = false
    for await (const { columns, rows } of sec.batches()) {
      if (!header) {
        yield `|${'-'.repeat(20)}\n| ${columns.map((c) => `*${texyCell(c)}`).join(' | ')}\n|${'-'.repeat(20)}\n`
        header = true
      }
      yield rows.map((row) => `| ${row.map(texyCell).join(' | ')}\n`).join('')
    }
  }
}

const wikiText = (c: Cell) =>
  (cellText(c) ?? "''NULL''")
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('{', '&#123;')
    .replaceAll('[', '&#91;')
    .replace(/^([*#:;=!-])/, (m) => `&#${m.charCodeAt(0)};`)
    .replace(/\r\n|\r|\n/g, '<br />')

/** MediaWiki `{| class="wikitable"` tables, a caption to each. */
export async function* mediawikiBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY
): AsyncIterable<string> {
  for (const [t, sec] of tables.flatMap((table) => tableSections(adapter, ns, table, o)).entries()) {
    yield `${t > 0 ? '\n' : ''}{| class="wikitable"\n|+ ${wikiText(sec.title)}\n`
    let header = false
    for await (const { columns, rows } of sec.batches()) {
      if (!header) {
        yield `|-\n${columns.map((c) => `! ${wikiText(c)}`).join('\n')}\n`
        header = true
      }
      yield rows.map((row) => `|-\n${row.map((c) => `| ${wikiText(c)}`).join('\n')}\n`).join('')
    }
    yield '|}\n'
  }
}

const htmlEscape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/**
 * A page of tables that prints well: the browser's print dialog (with "Save as PDF" as the destination) is how it
 * becomes a PDF.
 */
export async function* htmlBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY
): AsyncIterable<string> {
  yield '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  yield `<title>${htmlEscape(ns.database)}</title>\n`
  yield '<style>\nbody{font-family:system-ui,sans-serif;margin:1.5rem;color:#18181b}\nh2{font-size:1.1rem;margin:1.5rem 0 .5rem}\n'
  yield 'table{border-collapse:collapse;font-size:.8rem;width:100%}\nth,td{border:1px solid #71717a;padding:.2rem .4rem;text-align:left;vertical-align:top;white-space:pre-wrap}\n'
  yield 'th{background:#f4f4f5}\ni.null{color:#71717a}\ntr{break-inside:avoid}\nthead{display:table-header-group}\n'
  yield '@page{size:landscape;margin:12mm}\n</style>\n</head>\n<body>\n'
  for (const sec of tables.flatMap((table) => tableSections(adapter, ns, table, o))) {
    yield `<h2>${htmlEscape(sec.title)}</h2>\n<table>\n`
    let header = false
    for await (const { columns, rows } of sec.batches()) {
      if (!header) {
        yield `<thead><tr>${columns.map((c) => `<th>${htmlEscape(c)}</th>`).join('')}</tr></thead>\n<tbody>\n`
        header = true
      }
      yield rows
        .map(
          (row) =>
            `<tr>${row
              .map((c) => {
                const text = cellText(c)
                return text === null ? '<td><i class="null">NULL</i></td>' : `<td>${htmlEscape(text)}</td>`
              })
              .join('')}</tr>\n`
        )
        .join('')
    }
    yield '</tbody>\n</table>\n'
  }
  yield '</body>\n</html>\n'
}
