import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, Namespace } from '@tsmyadmin/shared'
import { EXPORT_BATCH_SIZE, isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'

/**
 * Data exports besides SQL, CSV and JSON: XML and YAML keep every value (NULL, binary and text told apart);
 * Markdown is a table for documents, so it shows binary values by size rather than carrying them.
 */

const ITER_OPTS = { batchSize: EXPORT_BATCH_SIZE }

/** The text of a value, refusing a cut one: a file must never look complete while holding a shortened value. */
function text(cell: Exclude<Cell, null>): string {
  if (isTruncatedCell(cell)) throw new Error('truncated text cannot be written to an export')
  return typeof cell === 'string' ? cell : String(cell)
}

/**
 * Whether the text holds a character XML 1.0 cannot carry at all, not even escaped (most control characters).
 * Lone surrogates are not looked for: the drivers decode what the server stores as UTF-8, which never yields one
 * (invalid bytes arrive as U+FFFD already), so no value read from the database can hold one.
 */
function xmlUnrepresentable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff) return true
  }
  return false
}
const xmlEscape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function xmlColumn(name: string, cell: Cell): string {
  const open = `<column name="${xmlEscape(name)}"`
  if (cell === null) return `${open} null="true"/>`
  if (isBinaryCell(cell)) return `${open} encoding="base64">${cell.$bin}</column>`
  const value = text(cell)
  // Text XML cannot carry (control characters) goes as base64 of its UTF-8 bytes, so nothing is lost or altered.
  if (xmlUnrepresentable(value)) {
    return `${open} encoding="base64">${Buffer.from(value, 'utf8').toString('base64')}</column>`
  }
  return `${open}>${xmlEscape(value)}</column>`
}

export async function* xmlBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<export database="${xmlEscape(ns.database)}"${ns.schema ? ` schema="${xmlEscape(ns.schema)}"` : ''}>\n`
  for (const table of tables) {
    yield `  <table name="${xmlEscape(table)}">\n`
    for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
      if (b.rows.length === 0) continue
      yield b.rows
        .map(
          (row) =>
            `    <row>\n${b.columns.map((c, i) => `      ${xmlColumn(c.name, row[i] ?? null)}`).join('\n')}\n    </row>\n`
        )
        .join('')
    }
    yield '  </table>\n'
  }
  yield '</export>\n'
}

/** A YAML scalar. JSON's double-quoted strings are YAML's too, so every string is written that way. */
function yamlValue(cell: Cell): string {
  if (cell === null) return 'null'
  if (isBinaryCell(cell)) return `!!binary ${cell.$bin}`
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
  return JSON.stringify(text(cell))
}

export async function* yamlBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  for (const table of tables) {
    let rows = 0
    for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
      if (b.rows.length === 0) continue
      if (rows === 0) yield `${JSON.stringify(table)}:\n`
      rows += b.rows.length
      yield b.rows
        .map(
          (row) =>
            `${b.columns.map((c, i) => `${i === 0 ? '  - ' : '    '}${JSON.stringify(c.name)}: ${yamlValue(row[i] ?? null)}`).join('\n')}\n`
        )
        .join('')
    }
    if (rows === 0) yield `${JSON.stringify(table)}: []\n`
  }
}

/** A Markdown table cell: pipes escaped, line breaks as <br>, so each row stays on one line. */
function markdownCell(cell: Cell): string {
  if (cell === null) return '*NULL*'
  if (isBinaryCell(cell)) return `*(binary, ${Buffer.from(cell.$bin, 'base64').length} bytes)*`
  return text(cell)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r\n|\r|\n/g, '<br>')
}

export async function* markdownBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  for (const [t, table] of tables.entries()) {
    yield `${t > 0 ? '\n' : ''}## ${table}\n\n`
    let header = false
    for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
      if (!header) {
        yield `| ${b.columns.map((c) => markdownCell(c.name)).join(' | ')} |\n`
        yield `|${b.columns.map(() => ' --- |').join('')}\n`
        header = true
      }
      if (b.rows.length > 0) yield b.rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |\n`).join('')
    }
  }
}
