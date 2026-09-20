import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, Namespace } from '@tsmyadmin/shared'
import { EXPORT_BATCH_SIZE, isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'
import { DATA_ONLY, type DocOptions, structureRows, tableSections } from './export-documents.ts'

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

/** An attribute's value: escaped, with the line breaks a parser would otherwise turn into spaces kept, and what XML cannot carry replaced. */
const xmlAttribute = (s: string) =>
  xmlEscape(Array.from(s, (ch) => (xmlUnrepresentable(ch) ? '\ufffd' : ch)).join(''))
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\t', '&#9;')

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

/** What XML adds to the tables, besides their structure and data: the definitions of these objects of the namespace. */
export interface XmlObjects {
  views: boolean
  routines: boolean
  triggers: boolean
}
const NO_XML_OBJECTS: XmlObjects = { views: false, routines: false, triggers: false }

/** A definition as a `<definition>` element: text XML cannot carry goes as base64, like a value does. */
function xmlDefinition(indent: string, sql: string): string {
  if (xmlUnrepresentable(sql)) {
    return `${indent}<definition encoding="base64">${Buffer.from(sql, 'utf8').toString('base64')}</definition>\n`
  }
  return `${indent}<definition>${xmlEscape(sql)}</definition>\n`
}

async function* xmlStructure(adapter: DatabaseAdapter, ns: Namespace, table: string): AsyncIterable<string> {
  const rows = await structureRows(adapter, ns, table)
  yield '    <structure>\n'
  for (const [name, type, nullable, def, key, extra, comment] of rows) {
    const attrs = [
      ['name', name],
      ['type', type],
      ['nullable', nullable === 'YES' ? 'true' : 'false'],
      ...(def === null ? [] : [['default', def]]),
      ...(key ? [['key', key]] : []),
      ...(extra ? [['extra', extra]] : []),
      ...(comment ? [['comment', comment]] : []),
    ]
    yield `      <column ${attrs.map(([k, v]) => `${k}="${xmlAttribute(text(v as string))}"`).join(' ')}/>\n`
  }
  yield '    </structure>\n'
}

async function* xmlObjects(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: XmlObjects
): AsyncIterable<string> {
  if (o.views) {
    const views = (await adapter.listTables(ns)).filter((t) => t.kind === 'view' || t.kind === 'materialized_view')
    if (views.length > 0) yield '  <views>\n'
    for (const v of views) {
      yield `    <view name="${xmlEscape(v.name)}">\n`
      // A view the account may not read is named without a definition rather than failing the download.
      try {
        yield xmlDefinition('      ', (await adapter.showCreateTable(ns, v.name)).join(';\n'))
      } catch {
        yield '      <unreadable/>\n'
      }
      yield '    </view>\n'
    }
    if (views.length > 0) yield '  </views>\n'
  }
  if (o.routines) {
    const seen = new Set<string>()
    const routines = (await adapter.listRoutines(ns)).filter((r) => {
      const key = `${r.kind}:${r.name}`
      return seen.has(key) ? false : (seen.add(key), true)
    })
    if (routines.length > 0) yield '  <routines>\n'
    for (const r of routines) {
      yield `    <routine name="${xmlEscape(r.name)}" kind="${xmlEscape(r.kind)}">\n`
      const def = await adapter.routineDefinition(ns, r.name, r.kind).catch(() => null)
      yield def === null ? '      <unreadable/>\n' : xmlDefinition('      ', def)
      yield '    </routine>\n'
    }
    if (routines.length > 0) yield '  </routines>\n'
  }
  if (o.triggers) {
    // Of the requested tables only, as in a SQL dump of some tables; a whole-namespace export names them all.
    const triggers = (await adapter.listTriggers(ns)).filter((t) => tables.includes(t.table))
    if (triggers.length > 0) yield '  <triggers>\n'
    for (const t of triggers) {
      yield `    <trigger name="${xmlEscape(t.name)}" table="${xmlEscape(t.table)}" timing="${xmlEscape(t.timing)}" events="${xmlEscape(t.events)}">\n`
      yield t.definition === null ? '      <unreadable/>\n' : xmlDefinition('      ', t.definition)
      yield '    </trigger>\n'
    }
    if (triggers.length > 0) yield '  </triggers>\n'
  }
}

export async function* xmlBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY,
  objects: XmlObjects = NO_XML_OBJECTS
): AsyncIterable<string> {
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<export database="${xmlEscape(ns.database)}"${ns.schema ? ` schema="${xmlEscape(ns.schema)}"` : ''}>\n`
  for (const table of tables) {
    yield `  <table name="${xmlEscape(table)}">\n`
    if (o.structure) yield* xmlStructure(adapter, ns, table)
    if (o.data) {
      for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
        if (b.rows.length === 0) continue
        yield b.rows
          .map(
            (row) =>
              `    <row>\n${b.columns.map((c, i) => `      ${xmlColumn(c.name, row[i] ?? null)}`).join('\n')}\n    </row>\n`
          )
          .join('')
      }
    }
    yield '  </table>\n'
  }
  yield* xmlObjects(adapter, ns, tables, objects)
  yield '</export>\n'
}

/** A YAML scalar. JSON's double-quoted strings are YAML's too, so every string is written that way. */
function yamlValue(cell: Cell): string {
  if (cell === null) return 'null'
  if (isBinaryCell(cell)) return `!!binary ${cell.$bin}`
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
  return JSON.stringify(text(cell))
}

export async function* yamlBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY
): AsyncIterable<string> {
  for (const table of tables) {
    for (const sec of tableSections(adapter, ns, table, o)) {
      let rows = 0
      for await (const b of sec.batches()) {
        if (b.rows.length === 0) continue
        if (rows === 0) yield `${JSON.stringify(sec.title)}:\n`
        rows += b.rows.length
        yield b.rows
          .map(
            (row) =>
              `${b.columns.map((c, i) => `${i === 0 ? '  - ' : '    '}${JSON.stringify(c)}: ${yamlValue(row[i] ?? null)}`).join('\n')}\n`
          )
          .join('')
      }
      if (rows === 0) yield `${JSON.stringify(sec.title)}: []\n`
    }
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

export async function* markdownBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY
): AsyncIterable<string> {
  for (const [t, sec] of tables.flatMap((table) => tableSections(adapter, ns, table, o)).entries()) {
    yield `${t > 0 ? '\n' : ''}## ${sec.title}\n\n`
    let header = false
    for await (const b of sec.batches()) {
      if (!header) {
        yield `| ${b.columns.map((c) => markdownCell(c)).join(' | ')} |\n`
        yield `|${b.columns.map(() => ' --- |').join('')}\n`
        header = true
      }
      if (b.rows.length > 0) yield b.rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |\n`).join('')
    }
  }
}
