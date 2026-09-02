import type { DatabaseAdapter, DropTarget, ProgramStatement } from '@tsmyadmin/adapter'
import { AdapterError, commentText, isGeneratedColumn, splitStatements } from '@tsmyadmin/adapter'
import type { ExportQuery, Namespace, ObjectDependency, TableSchema } from '@tsmyadmin/shared'
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
  /** Emitted before the tables (every MySQL routine; PostgreSQL string bodies, which DEFAULTs and indexes may call). */
  early: ProgramStatement[]
  /**
   * PostgreSQL routines that need a relation first — SQL-standard bodies, and signatures built on a table's row
   * type — by name: ordered after the tables, with the views they read or are read by.
   */
  late: Map<string, ProgramStatement[]>
  skipped: string[]
}

/** Whether a PostgreSQL routine's signature (the CREATE and RETURNS lines) names one of the relations. */
function signatureUses(statement: string, relations: string[]): boolean {
  const header = statement.split('\n').slice(0, 2).join('\n')
  return relations.some((r) =>
    new RegExp(`(?<![\\w])${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(header)
  )
}

/**
 * Routines of the namespace, read once (one definition per name and kind: PostgreSQL overloads share one).
 * `relationBound` maps a routine name to the tables / views the catalog ties it to: an overload whose
 * signature uses one of them (a row type) is created after that relation.
 */
async function collectRoutines(
  adapter: DatabaseAdapter,
  ns: Namespace,
  stripDefiner: boolean,
  relationBound: Map<string, string[]>
): Promise<Routines> {
  const x = adapter.exporter
  const seen = new Set<string>()
  const out: Routines = { early: [], late: new Map(), skipped: [] }
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
      out.early.push({ ...x.routine(ns, r.kind, r.name, def, stripDefiner), sqlMode: r.sqlMode })
      continue
    }
    // Overloads arrive as one statement each; the body style is decided per overload. A COMMENT ON that follows
    // an overload stays with it.
    let last: ProgramStatement | null = null
    for (const { sql } of splitStatements(def, 'postgres')) {
      if (/^COMMENT\s+ON\s/i.test(sql) && last) {
        last.sql += `;\n${sql}`
        continue
      }
      last = x.routine(ns, r.kind, r.name, sql, stripDefiner)
      if (isSqlStandardBody(sql) || signatureUses(sql, relationBound.get(r.name) ?? [])) {
        const group = out.late.get(r.name) ?? []
        group.push(last)
        out.late.set(r.name, group)
      } else out.early.push(last)
    }
  }
  return out
}

function routinesBody(adapter: DatabaseAdapter, routines: Routines): string {
  const parts: string[] = []
  if (routines.early.length > 0 || routines.skipped.length > 0) parts.push(section('Routines'))
  // A routine the account may not read is named rather than silently missing from the backup.
  for (const name of routines.skipped)
    parts.push(`-- skipped (definition not readable, or dropped meanwhile): ${commentText(name)}\n`)
  if (routines.skipped.length > 0) parts.push('\n')
  if (routines.early.length > 0) parts.push(adapter.exporter.programBlock(routines.early))
  return parts.join('')
}

/**
 * Where a relation reference starts in a view definition: after FROM / JOIN (optionally database-qualified) or
 * after `,` / `(`; a qualified name after `,` or `(` is a column reference, not a relation.
 */
const RELATION_REF = /(?:\b(?:from|join)\s+(?:`[^`]*`\.)?|[,(]\s*)/

/** A view, or a PostgreSQL SQL-standard-body routine, emitted after the tables in dependency order. */
interface LateObject {
  kind: 'view' | 'routine'
  name: string
  text: string
  /** Its definition text, for the mention fallback. */
  statements: string[]
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
 * Views and SQL-standard routines ordered so that each comes after what it depends on. The server catalog
 * decides where it exists (PostgreSQL pg_depend, MySQL 8 VIEW_*_USAGE); MariaDB keeps no such catalog, so there
 * a view follows the views its definition mentions (routines with parsed bodies do not exist on MariaDB).
 * Unrelated objects keep their name order; a cycle (impossible in a consistent catalog) is cut where found.
 */
function orderObjects(objects: LateObject[], catalog: ObjectDependency[] | null): LateObject[] {
  const key = (o: { kind: string; name: string }) => `${o.kind}:${o.name}`
  const byKey = new Map(objects.map((o) => [key(o), o]))
  // A relation reference follows FROM / JOIN / `,` / `(` (optionally database-qualified); an alias or a column
  // named like a view sits elsewhere. Backticks are optional so unnormalised definitions still match.
  const mentions = (o: LateObject, other: string) => {
    const name = other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`${RELATION_REF.source}(?:\`${name}\`|${name}(?![\\w$]))(?!\\s*\\.)`, 'i')
    return o.statements.some((s) => re.test(s))
  }
  const catalogByKey = new Map((catalog ?? []).map((d) => [key(d), d]))
  const dependencies = (o: LateObject): LateObject[] => {
    if (catalog) {
      const deps = catalogByKey.get(key(o))?.dependsOn ?? []
      return deps.map((d) => byKey.get(key(d))).filter((d): d is LateObject => d !== undefined && d !== o)
    }
    return objects.filter((dep) => dep !== o && dep.kind === 'view' && mentions(o, dep.name))
  }
  const out: LateObject[] = []
  const done = new Set<LateObject>()
  const emit = (o: LateObject) => {
    done.add(o)
    out.push(o)
  }
  // Returns false when `o` sits in a cycle with something still being visited. Routine entries are per name, so
  // a view that calls one overload (a string body, emitted long ago) and a SQL-standard overload that reads the
  // view look circular: the view goes first and the routine is picked up again from the outer loop.
  const visit = (o: LateObject, stack: Set<LateObject>): boolean => {
    if (done.has(o)) return true
    if (stack.has(o)) return false
    stack.add(o)
    let blocked = false
    for (const dep of dependencies(o)) if (!visit(dep, stack)) blocked = true
    stack.delete(o)
    if (blocked && o.kind === 'routine') return false
    emit(o)
    return true
  }
  for (const o of objects) visit(o, new Set())
  for (const o of objects) if (!done.has(o)) emit(o)
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
  const pg = adapter.dialect === 'postgres'
  const structure = q.structure === '1'
  const drops = structure && q.dropTable === '1'
  const schemas = new Map<string, TableSchema>()
  for (const table of tables) schemas.set(table, await adapter.describeTable(ns, table))
  // An inheritance child is created after its parents (multi-level: depth-first over the parents in the dump).
  const tableOrder: string[] = []
  const placed = new Set<string>()
  const place = (table: string, stack: Set<string>) => {
    if (placed.has(table) || stack.has(table)) return
    stack.add(table)
    for (const parent of schemas.get(table)?.inherits ?? []) if (schemas.has(parent)) place(parent, stack)
    placed.add(table)
    tableOrder.push(table)
  }
  for (const table of tables) place(table, new Set())
  // Routines go before the tables: a DEFAULT, a CHECK or a functional index may call one (PostgreSQL parses
  // string bodies only when called, see check_function_bodies in the preamble).
  const programs = structure && q.routines === '1'
  // PostgreSQL: the catalog says which routines are tied to a table or view (row-type signatures, SQL-standard
  // bodies) and must follow it; MySQL has no such catalog and needs none (routines cannot appear in DDL).
  const catalog = pg && (programs || schemas.size > 1) ? await adapter.listDependencies(ns) : null
  const relationBound = new Map(
    (catalog ?? [])
      .filter((d) => d.kind === 'routine')
      .map((d) => [d.name, d.dependsOn.filter((x) => x.kind !== 'routine').map((x) => x.name)])
  )
  const routines =
    programs && everything ? await collectRoutines(adapter, ns, q.stripDefiner === '1', relationBound) : null
  // Views and SQL-standard routines are emitted after every table, in dependency order (decided up front so a
  // PostgreSQL dump can also drop them first, dependents before their dependencies).
  const late: LateObject[] = []
  for (const [table, schema] of schemas) {
    if (schema.kind === 'table' || schema.kind === 'sequence' || !structure) continue
    const statements = (await adapter.showCreateTable(ns, table, schema)).map((stmt) =>
      q.stripDefiner === '1' ? adapter.exporter.withoutDefiner(stmt) : stmt
    )
    const all = drops && !pg ? [adapter.exporter.dropIfExists(ns, schema), ...statements] : statements
    late.push({
      kind: 'view',
      name: table,
      statements,
      text: `${section(`View: ${commentText(table)}`)}${all.map((stmt) => `${stmt};\n\n`).join('')}`,
    })
  }
  for (const [name, statements] of routines?.late ?? []) {
    late.push({
      kind: 'routine',
      name,
      statements: statements.map((s) => s.sql),
      text: `${section(`Routine: ${commentText(name)}`)}${adapter.exporter.programBlock(statements)}`,
    })
  }
  const ordered = orderObjects(late, catalog ?? (late.length > 1 ? await adapter.listDependencies(ns) : null))
  if (drops && pg) {
    const targets: DropTarget[] = [...ordered].reverse().map((o) => {
      if (o.kind === 'routine') return { kind: 'routine', name: o.name, statements: o.statements }
      return { kind: schemas.get(o.name)?.kind === 'materialized_view' ? 'materialized_view' : 'view', name: o.name }
    })
    for (const s of schemas.values()) if (s.kind === 'table') targets.push({ kind: 'table', name: s.name })
    const statements = adapter.exporter.dropAll(ns, targets)
    if (statements.length > 0) yield `${section('Drop')}${statements.map((stmt) => `${stmt};\n`).join('')}\n`
  }
  // A MariaDB sequence is created before the tables whose defaults call nextval() on it.
  for (const [table, schema] of schemas) {
    if (schema.kind !== 'sequence' || !structure) continue
    yield section(`Sequence: ${commentText(table)}`)
    if (drops) yield `${adapter.exporter.dropIfExists(ns, schema)};\n`
    for (const stmt of await adapter.showCreateTable(ns, table, schema)) yield `${stmt};\n\n`
  }
  if (routines) yield routinesBody(adapter, routines)
  for (const table of tableOrder) {
    // One catalog round trip per table, shared by the DDL reconstruction and the row scan.
    const schema = schemas.get(table) as TableSchema
    if (schema.kind !== 'table') continue
    yield section(`Table: ${commentText(table)}`)
    if (structure) {
      if (drops && !pg) yield `${adapter.exporter.dropIfExists(ns, schema)};\n`
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
  for (const o of ordered) yield o.text
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
