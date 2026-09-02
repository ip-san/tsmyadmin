import type { DatabaseAdapter, ProgramStatement } from '@tsmyadmin/adapter'
import { AdapterError, commentText, isGeneratedColumn, splitStatements } from '@tsmyadmin/adapter'
import type { ExportQuery, Namespace, TableSchema } from '@tsmyadmin/shared'
import { csvField, EXPORT_BATCH_SIZE } from '@tsmyadmin/shared'

export const DUMP_COMPLETE_MARKER = '-- tsmyadmin dump complete'
const FK_STATEMENT = /^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY/i
const ITER_OPTS = { batchSize: EXPORT_BATCH_SIZE }

export interface ExportFile {
  /** Chunks are produced lazily so a large table never has to fit in memory at once. */
  body: AsyncIterable<string>
  contentType: string
  filename: string
}

async function* csvBody(adapter: DatabaseAdapter, ns: Namespace, table: string, bom: boolean): AsyncIterable<string> {
  if (bom) yield '﻿'
  let header = false
  for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
    if (!header) {
      yield `${b.columns.map((c) => csvField(c.name)).join(',')}\r\n`
      header = true
    }
    if (b.rows.length > 0) yield `${b.rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`
  }
}

async function* jsonBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  yield '{\n'
  for (const [t, table] of tables.entries()) {
    yield `${t > 0 ? ',\n' : ''}  ${JSON.stringify(table)}: [`
    let first = true
    // One chunk per batch (like CSV) rather than per row: far fewer stream pulls for large tables.
    for await (const b of adapter.iterateRows(ns, table, ITER_OPTS)) {
      if (b.rows.length === 0) continue
      const lines = b.rows.map(
        (row) => `    ${JSON.stringify(Object.fromEntries(b.columns.map((c, i) => [c.name, row[i] ?? null])))}`
      )
      yield `${first ? '\n' : ',\n'}${lines.join(',\n')}`
      first = false
    }
    yield first ? ']' : '\n  ]'
  }
  yield '\n}\n'
}

/**
 * Stored routines, triggers and events. With `tables` given (a table-level export) only the triggers of those
 * tables are included; a whole-database dump carries everything. Statement text comes from the adapter's
 * exporter (the server's own CREATE definitions).
 */
const section = (title: string) =>
  `-- ----------------------------------------\n-- ${title}\n-- ----------------------------------------\n\n`

/**
 * PostgreSQL SQL-standard function bodies (`BEGIN ATOMIC` / bare `RETURN`) are parsed at CREATE time, so a body
 * that reads a view can only be created after the view; string bodies (`AS $$…$$`) are not validated
 * (check_function_bodies = false) and go first, where views can call them.
 */
function isSqlStandardBody(statement: string): boolean {
  return !/\sAS\s+\$/i.test(statement) && /\b(?:BEGIN\s+ATOMIC|RETURN)\b/i.test(statement)
}

interface Routines {
  /** Emitted before the views (every MySQL routine; PostgreSQL string bodies). */
  stringBody: ProgramStatement[]
  /** PostgreSQL SQL-standard bodies: emitted after the views they may read. */
  sqlBody: ProgramStatement[]
  skipped: string[]
}

/** Routines of the namespace, read once (one definition per name and kind: PostgreSQL overloads share one). */
async function collectRoutines(adapter: DatabaseAdapter, ns: Namespace, stripDefiner: boolean): Promise<Routines> {
  const x = adapter.exporter
  const seen = new Set<string>()
  const out: Routines = { stringBody: [], sqlBody: [], skipped: [] }
  for (const r of await adapter.listRoutines(ns)) {
    if (seen.has(`${r.kind}:${r.name}`)) continue
    seen.add(`${r.kind}:${r.name}`)
    let def: string | null
    try {
      def = await adapter.routineDefinition(ns, r.name, r.kind)
    } catch (err) {
      // Dropped between the listing and the SHOW CREATE: named in the dump rather than aborting the download.
      if (err instanceof AdapterError && err.code === 'NOT_FOUND') def = null
      else throw err
    }
    if (def === null) {
      out.skipped.push(`${r.kind} ${r.name}`)
      continue
    }
    if (adapter.dialect !== 'postgres') {
      out.stringBody.push({ ...x.routine(ns, r.kind, r.name, def, stripDefiner), sqlMode: r.sqlMode })
      continue
    }
    // Overloads arrive as one statement each; the body style is decided per overload.
    for (const { sql } of splitStatements(def, 'postgres')) {
      ;(isSqlStandardBody(sql) ? out.sqlBody : out.stringBody).push(x.routine(ns, r.kind, r.name, sql, stripDefiner))
    }
  }
  return out
}

async function* routinesBody(
  adapter: DatabaseAdapter,
  routines: Routines,
  phase: 'stringBody' | 'sqlBody'
): AsyncIterable<string> {
  const defs = routines[phase]
  const skipped = phase === 'stringBody' ? routines.skipped : []
  if (defs.length > 0 || skipped.length > 0)
    yield section(phase === 'sqlBody' ? 'Routines (SQL-standard bodies)' : 'Routines')
  // A routine the account may not read is named rather than silently missing from the backup.
  for (const name of skipped) yield `-- skipped (definition not readable, or dropped meanwhile): ${commentText(name)}\n`
  if (skipped.length > 0) yield '\n'
  if (defs.length > 0) yield adapter.exporter.programBlock(defs)
}

/** Triggers (of the given tables, or all) and, for a whole-database dump, events. */
async function* triggersAndEventsBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[] | null,
  stripDefiner: boolean
): AsyncIterable<string> {
  const x = adapter.exporter
  const triggers = (await adapter.listTriggers(ns))
    .filter((t) => t.definition !== null && (tables === null || tables.includes(t.table)))
    .map((t) => x.trigger(ns, t, stripDefiner))
  if (triggers.length > 0) {
    yield section('Triggers')
    yield x.programBlock(triggers)
  }
  if (tables === null && adapter.dialect === 'mysql') {
    const events = (await adapter.listEvents(ns))
      .filter((e) => e.definition !== null)
      .map((e) => x.event(ns, e, stripDefiner))
    if (events.length > 0) {
      yield section('Events')
      yield x.programBlock(events)
    }
  }
}

/**
 * Views ordered so that a view comes after the views it mentions (text dependency: a view definition that
 * names another view of the dump). Catalogs differ per server (MariaDB has no VIEW_TABLE_USAGE), and the
 * definition text is already in hand, so the mention test is the portable choice; unrelated views keep their
 * name order.
 */
function orderViews(views: { name: string; statements: string[] }[]): { name: string; statements: string[] }[] {
  const mentions = (v: { statements: string[] }, other: string) =>
    v.statements.some((s) => new RegExp(`(?<![\\w$])${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(s))
  const out: { name: string; statements: string[] }[] = []
  const done = new Set<string>()
  const visit = (v: { name: string; statements: string[] }, stack: Set<string>) => {
    if (done.has(v.name) || stack.has(v.name)) return
    stack.add(v.name)
    for (const dep of views) if (dep.name !== v.name && mentions(v, dep.name)) visit(dep, stack)
    done.add(v.name)
    out.push(v)
  }
  for (const v of views) visit(v, new Set())
  return out
}

async function* sqlBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  q: ExportQuery,
  everything: boolean
): AsyncIterable<string> {
  yield [
    '-- tsmyadmin SQL dump',
    `-- Dialect: ${adapter.dialect}`,
    `-- Database: ${commentText(ns.database)}${ns.schema ? ` / schema ${commentText(ns.schema)}` : ''}`,
    `-- Generated: ${new Date().toISOString()}`,
    '',
    ...adapter.exporter.preamble(ns),
    '',
    '',
  ].join('\n')
  const deferred: string[] = []
  // Views are emitted after the routines they may call (and after every table), in dependency order.
  const views: { name: string; statements: string[] }[] = []
  // A MariaDB sequence is created before the tables whose defaults call nextval() on it.
  const schemas = new Map<string, TableSchema>()
  for (const table of tables) schemas.set(table, await adapter.describeTable(ns, table))
  for (const [table, schema] of schemas) {
    if (schema.kind !== 'sequence' || q.structure !== '1') continue
    yield section(`Sequence: ${commentText(table)}`)
    if (q.dropTable === '1') yield `${adapter.exporter.dropIfExists(ns, schema)};\n`
    for (const stmt of await adapter.showCreateTable(ns, table, schema)) yield `${stmt};\n\n`
  }
  for (const table of tables) {
    // One catalog round trip per table, shared by the DDL reconstruction and the row scan.
    const schema = schemas.get(table) as TableSchema
    if (schema.kind === 'sequence') continue
    if (schema.kind !== 'table') {
      if (q.structure === '1') {
        const statements = (await adapter.showCreateTable(ns, table, schema)).map((stmt) =>
          q.stripDefiner === '1' ? adapter.exporter.withoutDefiner(stmt) : stmt
        )
        views.push({
          name: table,
          statements: q.dropTable === '1' ? [adapter.exporter.dropIfExists(ns, schema), ...statements] : statements,
        })
      }
      continue
    }
    yield section(`Table: ${commentText(table)}`)
    if (q.structure === '1') {
      if (q.dropTable === '1') yield `${adapter.exporter.dropIfExists(ns, schema)};\n`
      for (const stmt of await adapter.showCreateTable(ns, table, schema)) {
        // PostgreSQL has no FOREIGN_KEY_CHECKS: constraints are emitted after every table exists and is loaded.
        if (adapter.dialect === 'postgres' && FK_STATEMENT.test(stmt)) deferred.push(stmt)
        else yield `${stmt};\n\n`
      }
    }
    if (q.data === '1' && schema.kind === 'table') {
      // Generated columns are computed by the server and rejected in INSERT; identity ALWAYS columns need
      // OVERRIDING SYSTEM VALUE; sequences are advanced afterwards so the next insert does not collide.
      const generated = new Set(schema.columns.filter((c) => isGeneratedColumn(c.extra)).map((c) => c.name))
      const overriding = schema.columns.some((c) => c.extra === 'identity always')
      for await (const b of adapter.iterateRows(ns, table, { ...ITER_OPTS, schema })) {
        const keep = b.columns.map((c, i) => (generated.has(c.name) ? -1 : i)).filter((i) => i >= 0)
        const stmt = adapter.exporter.insert(
          ns,
          table,
          keep.map((i) => b.columns[i]?.name ?? ''),
          b.rows.map((row) => keep.map((i) => row[i] ?? null)),
          { overriding }
        )
        if (stmt) yield `${stmt}\n\n`
      }
      for (const stmt of adapter.exporter.afterData(ns, schema)) yield `${stmt}\n\n`
    }
  }
  if (deferred.length > 0) {
    yield section('Foreign keys')
    for (const stmt of deferred) yield `${stmt};\n\n`
  }
  const programs = q.structure === '1' && q.routines === '1'
  const routines = programs && everything ? await collectRoutines(adapter, ns, q.stripDefiner === '1') : null
  if (routines) yield* routinesBody(adapter, routines, 'stringBody')
  for (const v of orderViews(views)) {
    yield section(`View: ${commentText(v.name)}`)
    for (const stmt of v.statements) yield `${stmt};\n\n`
  }
  if (routines) yield* routinesBody(adapter, routines, 'sqlBody')
  if (programs) yield* triggersAndEventsBody(adapter, ns, everything ? null : tables, q.stripDefiner === '1')
  const postamble = adapter.exporter.postamble()
  if (postamble.length > 0) yield `${postamble.join('\n')}\n\n`
  // Terminal marker: a dump that lacks this line was cut short (the transfer is also aborted on errors).
  yield `${DUMP_COMPLETE_MARKER} (${tables.length} table${tables.length === 1 ? '' : 's'})\n`
}

/** Response body for a chunk stream. A failing chunk errors the stream (the client sees a failed transfer). */
export function toReadableStream(
  body: AsyncIterable<string>,
  onError?: (err: unknown) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = body[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<string>
      try {
        next = await iterator.next()
      } catch (err) {
        onError?.(err)
        throw err
      }
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/**
 * Builds a dump of `tables` in the requested format as a lazy chunk stream.
 * `baseName` is the file name without extension (db, or db_table when one table was requested explicitly).
 */
export function buildExport(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  q: ExportQuery,
  baseName: string = ns.database,
  /** True for a whole-namespace dump (routines and events included); false when tables were named. */
  everything = true
): ExportFile {
  if (q.format === 'csv') {
    const table = tables[0]
    if (tables.length !== 1 || !table) throw new Error('CSV export needs exactly one table')
    return {
      body: csvBody(adapter, ns, table, q.bom === '1'),
      contentType: 'text/csv; charset=utf-8',
      filename: `${baseName}.csv`,
    }
  }
  if (q.format === 'json') {
    return {
      body: jsonBody(adapter, ns, tables),
      contentType: 'application/json; charset=utf-8',
      filename: `${baseName}.json`,
    }
  }
  return {
    body: sqlBody(adapter, ns, tables, q, everything),
    contentType: 'application/sql; charset=utf-8',
    filename: `${baseName}.sql`,
  }
}

/** Collects a chunk stream into one string (tests, small exports). */
export async function collect(body: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of body) out += chunk
  return out
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback for non-Latin names. */
export function contentDisposition(filename: string): string {
  // Quoted-string fallback: printable ASCII only, no quote or backslash (both would end/escape the string).
  const ascii = filename.replaceAll(/[^\x20-\x7E]/g, '_').replaceAll(/["\\]/g, '')
  // RFC 8187 attr-char excludes `!'()*`, which encodeURIComponent leaves bare.
  const encoded = encodeURIComponent(filename).replaceAll(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
