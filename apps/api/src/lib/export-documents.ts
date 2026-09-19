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
export async function* tableRows(
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
export async function* latexBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  yield `% tsmyadmin LaTeX export\n% Database: ${ns.database.replace(/[\r\n]/g, ' ')}\n`
  yield '\\documentclass{article}\n\\usepackage{longtable}\n\\usepackage[margin=1.5cm,landscape]{geometry}\n\\begin{document}\n'
  for (const table of tables) {
    let opened = false
    for await (const { columns, rows } of tableRows(adapter, ns, table)) {
      if (!opened) {
        yield `\n\\begin{longtable}{|${columns.map(() => 'l|').join('')}}\n`
        yield `\\hline \\multicolumn{${columns.length}}{|c|}{\\textbf{${latexEscape(table)}}} \\\\ \\hline\n`
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
export async function* texyBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  for (const [t, table] of tables.entries()) {
    yield `${t > 0 ? '\n' : ''}===${table.replace(/[\r\n]/g, ' ')}\n\n`
    let header = false
    for await (const { columns, rows } of tableRows(adapter, ns, table)) {
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
export async function* mediawikiBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  for (const [t, table] of tables.entries()) {
    yield `${t > 0 ? '\n' : ''}{| class="wikitable"\n|+ ${wikiText(table)}\n`
    let header = false
    for await (const { columns, rows } of tableRows(adapter, ns, table)) {
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
export async function* htmlBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  yield '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  yield `<title>${htmlEscape(ns.database)}</title>\n`
  yield '<style>\nbody{font-family:system-ui,sans-serif;margin:1.5rem;color:#18181b}\nh2{font-size:1.1rem;margin:1.5rem 0 .5rem}\n'
  yield 'table{border-collapse:collapse;font-size:.8rem;width:100%}\nth,td{border:1px solid #71717a;padding:.2rem .4rem;text-align:left;vertical-align:top;white-space:pre-wrap}\n'
  yield 'th{background:#f4f4f5}\ni.null{color:#71717a}\ntr{break-inside:avoid}\nthead{display:table-header-group}\n'
  yield '@page{size:landscape;margin:12mm}\n</style>\n</head>\n<body>\n'
  for (const table of tables) {
    yield `<h2>${htmlEscape(table)}</h2>\n<table>\n`
    let header = false
    for await (const { columns, rows } of tableRows(adapter, ns, table)) {
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
