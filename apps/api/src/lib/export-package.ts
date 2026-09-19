import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ExportCharset, ExportQuery, Namespace, ServerExportQuery, TableInfo } from '@tsmyadmin/shared'
import { BINARY_FORMATS } from '@tsmyadmin/shared'
import iconv from 'iconv-lite'
import { buildExport, type ExportFile } from './export.ts'
import { compressStream, toBytes, type ZipEntry, zipStream } from './zip.ts'

/**
 * The last stage of an export: the file name from a template, the character set, and the wrapping in gzip or ZIP
 * (one file per table always makes a ZIP). Every stage streams: nothing here holds the whole dump.
 */

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** A file name from its parts: characters no file system takes are replaced, and a name that empties out is refused. */
export function safeFileName(name: string): string {
  const cleaned = Array.from(name, (ch) => (ch.charCodeAt(0) < 0x20 || '/\\:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^\.+/, '_')
    .trim()
  return cleaned.slice(0, 150)
}

/**
 * `@DATABASE@`, `@TABLE@`, `@SERVER@` and `%Y %y %m %d %H %M %S` replaced. Anything else stays as typed, and the
 * result is cleaned like any file name; an empty result falls back to `fallback`.
 */
export function renderFileName(
  template: string | undefined,
  parts: { database: string; table?: string | undefined; server: string; now: Date },
  fallback: string
): string {
  if (!template?.trim()) return fallback
  const d = parts.now
  const rendered = template
    .replaceAll('@DATABASE@', parts.database)
    .replaceAll('@DB@', parts.database)
    .replaceAll('@TABLE@', parts.table ?? parts.database)
    .replaceAll('@SERVER@', parts.server)
    .replace(/%([YymdHMS%])/g, (_, c: string) => {
      switch (c) {
        case 'Y':
          return pad(d.getFullYear(), 4)
        case 'y':
          return pad(d.getFullYear() % 100)
        case 'm':
          return pad(d.getMonth() + 1)
        case 'd':
          return pad(d.getDate())
        case 'H':
          return pad(d.getHours())
        case 'M':
          return pad(d.getMinutes())
        case 'S':
          return pad(d.getSeconds())
        default:
          return '%'
      }
    })
  return safeFileName(rendered) || fallback
}

/**
 * Text encoded in a character set. A character the set cannot hold would be written as `?` by the encoder: a dump
 * must not lose data silently, so each chunk is decoded again and compared, and a mismatch stops the export.
 */
export async function* encodeText(
  body: AsyncIterable<string | Uint8Array>,
  charset: ExportCharset
): AsyncIterable<Uint8Array> {
  let first = true
  for await (const raw of body) {
    if (typeof raw !== 'string') {
      yield raw
      continue
    }
    if (charset === 'utf-8') {
      yield toBytes(raw)
      continue
    }
    // A byte-order mark is UTF-8's: no other set has one to write.
    const chunk = first && raw.startsWith('\ufeff') ? raw.slice(1) : raw
    first = false
    const bytes = iconv.encode(chunk, charset)
    if (iconv.decode(bytes, charset) !== chunk)
      throw new Error(`The text has characters that ${charset} cannot hold: export it as UTF-8`)
    yield bytes
  }
}

const withCharset = (contentType: string, charset: ExportCharset) =>
  contentType.replace(/charset=[\w-]+/i, `charset=${charset}`)

/**
 * The adapter with `iterateRows` limited to a slice of each table: the first `offset` rows skipped, then at most
 * `limit` (0 is no limit). Everything else is the adapter's own, so every format gets the range the same way.
 */
export function withRowRange(adapter: DatabaseAdapter, offset: number, limit: number): DatabaseAdapter {
  async function* ranged(ns: Namespace, table: string, opts: Parameters<DatabaseAdapter['iterateRows']>[2]) {
    let skipped = 0
    let taken = 0
    for await (const batch of adapter.iterateRows(ns, table, opts)) {
      let rows = batch.rows
      const drop = Math.min(offset - skipped, rows.length)
      if (drop > 0) {
        rows = rows.slice(drop)
        skipped += drop
      }
      if (limit > 0) rows = rows.slice(0, limit - taken)
      taken += rows.length
      // Every batch is passed on, empty ones too: the first tells a consumer the column names.
      yield { columns: batch.columns, rows }
      if (limit > 0 && taken >= limit) return
    }
  }
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'iterateRows') return ranged
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export interface PackagedExport {
  body: AsyncIterable<Uint8Array>
  contentType: string
  filename: string
}

/**
 * The export as the file to send: named by the template, encoded, and compressed or split as asked.
 * `everything` and `listing` are as for buildExport.
 */
export function buildPackagedExport(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  q: ExportQuery,
  o: { server: string; baseName: string; everything: boolean; listing?: TableInfo[]; now?: Date }
): PackagedExport {
  const now = o.now ?? new Date()
  const source = q.rowOffset > 0 || q.rowLimit > 0 ? withRowRange(adapter, q.rowOffset, q.rowLimit) : adapter
  const binary = BINARY_FORMATS.includes(q.format)
  const named = (table?: string) =>
    renderFileName(q.filename, { database: ns.database, table, server: o.server, now }, o.baseName)
  const extension = (file: ExportFile) => file.filename.slice(file.filename.lastIndexOf('.'))
  const encode = (file: ExportFile): AsyncIterable<Uint8Array> =>
    binary ? asBytes(file.body) : encodeText(file.body, q.charset)
  if (q.filePerTable === '1') {
    async function* entries(): AsyncIterable<ZipEntry> {
      for (const table of tables) {
        // Each table on its own, so a routine or trigger goes with the one it belongs to.
        const file = buildExport(source, ns, [table], q, table, false, o.listing)
        yield { name: `${named(table)}${extension(file)}`, data: encode(file) }
      }
    }
    return { body: zipStream(entries(), now), contentType: 'application/zip', filename: `${named()}.zip` }
  }
  // A single table named on its own is what @TABLE@ means; a whole database has only its own name.
  const only = !o.everything && tables.length === 1 ? tables[0] : undefined
  const file = buildExport(source, ns, tables, q, named(only), o.everything, o.listing)
  const contentType = binary ? file.contentType : withCharset(file.contentType, q.charset)
  if (q.compress === 'gzip') {
    return {
      body: compressStream('gzip', encode(file)),
      contentType: 'application/gzip',
      filename: `${file.filename}.gz`,
    }
  }
  if (q.compress === 'zip') {
    return {
      body: zipStream([{ name: file.filename, data: encode(file) }], now),
      contentType: 'application/zip',
      filename: `${named(only)}.zip`,
    }
  }
  return { body: encode(file), contentType, filename: file.filename }
}

async function* asBytes(body: AsyncIterable<string | Uint8Array>): AsyncIterable<Uint8Array> {
  for await (const chunk of body) yield toBytes(chunk)
}

/**
 * Several databases (MySQL) or schemas (PostgreSQL) as one SQL dump — or, with `filePerTable`, one file each in a zip.
 * Each is written whole (routines and events too) with its own CREATE DATABASE / SCHEMA, so the dump can be run from
 * a connection that is in none of them.
 */
export function buildServerExport(
  adapter: DatabaseAdapter,
  targets: Namespace[],
  q: ServerExportQuery,
  o: { server: string; now?: Date }
): PackagedExport {
  const now = o.now ?? new Date()
  const source = q.rowOffset > 0 || q.rowLimit > 0 ? withRowRange(adapter, q.rowOffset, q.rowLimit) : adapter
  const asQuery: ExportQuery = { ...q, format: 'sql', createDatabase: '1', schema: undefined, tables: undefined }
  const label = (ns: Namespace) => ns.schema ?? ns.database
  const named = (target?: string) =>
    renderFileName(q.filename, { database: target ?? 'server', server: o.server, now }, target ?? 'server')
  const dump = async (ns: Namespace) => {
    const listing = await source.listTables(ns)
    // Tables before views, so a CREATE VIEW follows the tables it reads.
    const tables = [...listing.filter((t) => t.kind === 'table'), ...listing.filter((t) => t.kind !== 'table')].map(
      (t) => t.name
    )
    return buildExport(source, ns, tables, asQuery, label(ns), true, listing)
  }
  const encode = (body: AsyncIterable<string | Uint8Array>) => encodeText(body, q.charset)
  if (q.filePerTable === '1') {
    async function* entries(): AsyncIterable<ZipEntry> {
      for (const ns of targets) {
        const file = await dump(ns)
        yield { name: `${named(label(ns))}.sql`, data: encode(file.body) }
      }
    }
    return { body: zipStream(entries(), now), contentType: 'application/zip', filename: `${named()}.zip` }
  }
  async function* all(): AsyncIterable<string> {
    for (const [i, ns] of targets.entries()) {
      if (i > 0) yield '\n'
      yield* (await dump(ns)).body as AsyncIterable<string>
    }
  }
  const type = withCharset('application/sql; charset=utf-8', q.charset)
  if (q.compress === 'gzip')
    return {
      body: compressStream('gzip', encode(all())),
      contentType: 'application/gzip',
      filename: `${named()}.sql.gz`,
    }
  if (q.compress === 'zip')
    return {
      body: zipStream([{ name: `${named()}.sql`, data: encode(all()) }], now),
      contentType: 'application/zip',
      filename: `${named()}.zip`,
    }
  return { body: encode(all()), contentType: type, filename: `${named()}.sql` }
}
