import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import {
  BrowseQuerySchema,
  CellQuerySchema,
  DatabasesQuerySchema,
  DdlPreviewRequestSchema,
  DeleteRowsRequestSchema,
  type Dialect,
  decodeTableList,
  ExportQuerySchema,
  IMPORT_MAX_BYTES,
  ImportFormSchema,
  InsertRowRequestSchema,
  isGeneratedColumn,
  type Namespace,
  parseBrowseQuery,
  parseCellKey,
  QueryBuilderRequestSchema,
  RoutineDefinitionQuerySchema,
  RoutineDetailQuerySchema,
  SchemaQuerySchema,
  SINGLE_TABLE_FORMATS,
  SqlCancelRequestSchema,
  SqlRequestSchema,
  type SqlStreamEvent,
  type StatementResult,
  TableSearchQuerySchema,
  TriggerDetailQuerySchema,
  TriggerQuerySchema,
  UpdateRowRequestSchema,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { DatabaseOpRefused, prepareDatabaseOp } from '../lib/database-ops.ts'
import { apiError, toApiError } from '../lib/errors.ts'
import { contentDisposition, toReadableStream } from '../lib/export.ts'
import { buildPackagedExport, keylessTables } from '../lib/export-package.ts'
import { identifierTooLong, tooLongIdentifier } from '../lib/identifiers.ts'
import { ImportValidationError } from '../lib/import.ts'
import { importResponse, type PreparedImport, prepareImport, validationError } from '../lib/import-run.ts'
import type { Logger } from '../lib/logging.ts'
import { recordGridChange, recordStatements } from '../lib/tracking-log.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

function ns(database: string, schema?: string): Namespace {
  return schema ? { database, schema } : { database }
}

/** Columns of `table` fed by a sequence of their own (serial, or a sequence OWNED BY the column). */
async function ownedSequenceColumns(
  adapter: DatabaseAdapter,
  target: Namespace,
  table: string,
  columns: string[]
): Promise<string[]> {
  if (adapter.dialect !== 'postgres') return []
  const schema = await adapter.describeTable(target, table)
  const own = new Set(schema.columns.filter((col) => col.extra === 'serial').map((col) => col.name))
  for (const t of await adapter.listTables(target))
    if (t.kind === 'sequence' && t.ownedBy?.table === table && columns.includes(t.ownedBy.column))
      own.add(t.ownedBy.column)
  return [...own]
}

/** Blank line sent on an NDJSON stream while a statement runs (well inside every idle timeout in the path). */
const HEARTBEAT_MS = 15_000
/** NDJSON responses: progress lines must reach the browser as they are written, not when a proxy buffer fills. */
const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

const BEGIN = /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i
const COMMIT = /^\s*(?:COMMIT|END)\b/i
const ROLLBACK = /^\s*ROLLBACK\b(?!\s+TO\b)/i
/** Savepoints: transaction control, not a change of their own. */
const SAVEPOINT = /^\s*(?:SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/i
/** MySQL commits the open transaction before (and after) a statement that changes a definition. */
const MYSQL_IMPLICIT_COMMIT = /^\s*(?:CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i

/**
 * The statements whose effect stayed, for tracking: one per statement (a CALL's several result sets share it), not
 * the failed ones, and not what ran inside a transaction that was rolled back — or left open, which the connection
 * rolls back when the script ends. MySQL's definition statements commit implicitly; PostgreSQL's are
 * transactional like any other.
 */
export function executed(results: readonly StatementResult[], dialect: Dialect): string[] {
  const seen = new Set<number>()
  const kept: string[] = []
  let pending: string[] | null = null
  results.forEach((r, i) => {
    const at = r.statement ?? i
    if (r.kind === 'error' || seen.has(at)) return
    seen.add(at)
    if (SAVEPOINT.test(r.sql)) return
    if (BEGIN.test(r.sql)) pending = []
    else if (COMMIT.test(r.sql)) {
      kept.push(...(pending ?? []))
      pending = null
    } else if (ROLLBACK.test(r.sql)) pending = null
    else if (pending !== null && dialect === 'mysql' && MYSQL_IMPLICIT_COMMIT.test(r.sql)) {
      kept.push(...pending, r.sql)
      pending = null
    } else if (pending !== null) pending.push(r.sql)
    else kept.push(r.sql)
  })
  return kept
}

export function databaseRoutes(cfg: SessionConfig, logger?: Logger) {
  return (
    new Hono<AppEnv>()
      .use('/databases/*', requireSession(cfg))
      .use('/databases', requireSession(cfg))
      .get('/databases', validate('query', DatabasesQuerySchema), async (c) =>
        c.json(await c.get('session').adapter.listDatabases({ stats: c.req.valid('query').stats !== '0' }))
      )
      .get('/databases/:db/schemas', async (c) => c.json(await c.get('session').adapter.listSchemas(c.req.param('db'))))
      .get('/databases/:db/tables', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.listTables(ns(c.req.param('db'), q.schema)))
      })
      // Every foreign key of the database (or schema) in one catalog query, for the designer.
      .get('/databases/:db/foreign-keys', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.listForeignKeys(ns(c.req.param('db'), q.schema)))
      })
      .get('/databases/:db/routines', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.listRoutines(ns(c.req.param('db'), q.schema)))
      })
      .get('/databases/:db/routines/:name/definition', validate('query', RoutineDefinitionQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const definition = await c
          .get('session')
          .adapter.routineDefinition(ns(c.req.param('db'), q.schema), c.req.param('name'), q.kind)
        return c.json({ definition })
      })
      // What the create form takes, read back to edit a routine, trigger or event (null: not editable there).
      .get('/databases/:db/routines/:name/detail', validate('query', RoutineDetailQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(
          await c
            .get('session')
            .adapter.routineDetail(ns(c.req.param('db'), q.schema), c.req.param('name'), q.kind, q.parameters)
        )
      })
      .get('/databases/:db/triggers/:name/detail', validate('query', TriggerDetailQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(
          await c.get('session').adapter.triggerDetail(ns(c.req.param('db'), q.schema), q.table, c.req.param('name'))
        )
      })
      .get('/databases/:db/events/:name/detail', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.eventDetail(ns(c.req.param('db'), q.schema), c.req.param('name')))
      })
      .get('/databases/:db/triggers', validate('query', TriggerQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.listTriggers(ns(c.req.param('db'), q.schema), q.table))
      })
      .get('/databases/:db/events', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.listEvents(ns(c.req.param('db'), q.schema)))
      })
      .get('/databases/:db/tables/:table/structure', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(
          await c.get('session').adapter.describeTable(ns(c.req.param('db'), q.schema), c.req.param('table'))
        )
      })
      .get('/databases/:db/tables/:table/partitions', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(
          await c.get('session').adapter.listPartitions(ns(c.req.param('db'), q.schema), c.req.param('table'))
        )
      })
      .get('/databases/:db/tables/:table/count', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const count = await c.get('session').adapter.countRows(ns(c.req.param('db'), q.schema), c.req.param('table'))
        return c.json({ count })
      })
      .get('/databases/:db/tables/:table/stats', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.tableStats(ns(c.req.param('db'), q.schema), c.req.param('table')))
      })
      .get('/databases/:db/tables/:table/create', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const sql = await c
          .get('session')
          .adapter.showCreateTable(ns(c.req.param('db'), q.schema), c.req.param('table'))
        return c.json({ sql })
      })
      // One table per request: the page runs them in turn, so a search can stop between tables and never ties up the
      // session's small connection pool with a scan per table at once.
      .get('/databases/:db/tables/:table/search', validate('query', TableSearchQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const result = await c
          .get('session')
          .adapter.searchTable(ns(c.req.param('db'), q.schema), c.req.param('table'), q.q, {
            mode: q.mode,
            ...(q.column ? { column: q.column } : {}),
          })
        return c.json(result)
      })
      .get('/databases/:db/tables/:table/rows', validate('query', BrowseQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const parsed = parseBrowseQuery(q)
        if (!parsed.ok) return c.json(apiError('VALIDATION', parsed.message), 400)
        const result = await c
          .get('session')
          .adapter.browseRows(ns(c.req.param('db'), q.schema), c.req.param('table'), parsed.options)
        return c.json(result)
      })
      // One value whole, as a download (a browse page cuts binary values at 64 KB): opened as a link.
      .get('/databases/:db/tables/:table/cell', validate('query', CellQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const key = parseCellKey(q.key)
        if (!key) return c.json(apiError('VALIDATION', 'Invalid row key'), 400)
        const table = c.req.param('table')
        const cell = await c.get('session').adapter.readCell(ns(c.req.param('db'), q.schema), table, key, q.column)
        if (cell === null) return c.json(apiError('NOT_FOUND', 'The value is NULL'), 404)
        const binary = typeof cell === 'object' && '$bin' in cell
        const body = binary
          ? Buffer.from(cell.$bin, 'base64')
          : typeof cell === 'object' && '$text' in cell
            ? cell.$text
            : String(cell)
        return c.body(body, 200, {
          'Content-Type': binary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
          'Content-Disposition': contentDisposition(`${table}.${q.column}.${binary ? 'bin' : 'txt'}`),
        })
      })
      .post(
        '/databases/:db/tables/:table/rows',
        validate('query', SchemaQuerySchema),
        validate('json', InsertRowRequestSchema),
        async (c) => {
          const q = c.req.valid('query')
          const body = c.req.valid('json')
          const namespace = ns(c.req.param('db'), q.schema)
          const r = await c.get('session').adapter.insertRow(namespace, c.req.param('table'), body.values)
          await recordGridChange(
            cfg.store.sharedItems,
            c.get('session').config,
            namespace,
            c.req.param('table'),
            'insert',
            r.affectedRows,
            Object.keys(body.values),
            logger
          )
          return c.json(r, 201)
        }
      )
      .patch(
        '/databases/:db/tables/:table/rows',
        validate('query', SchemaQuerySchema),
        validate('json', UpdateRowRequestSchema),
        async (c) => {
          const q = c.req.valid('query')
          const body = c.req.valid('json')
          const namespace = ns(c.req.param('db'), q.schema)
          const r = await c.get('session').adapter.updateRow(namespace, c.req.param('table'), body.key, body.values)
          await recordGridChange(
            cfg.store.sharedItems,
            c.get('session').config,
            namespace,
            c.req.param('table'),
            'update',
            r.affectedRows,
            Object.keys(body.values),
            logger
          )
          return c.json(r)
        }
      )
      .delete(
        '/databases/:db/tables/:table/rows',
        validate('query', SchemaQuerySchema),
        validate('json', DeleteRowsRequestSchema),
        async (c) => {
          const q = c.req.valid('query')
          const body = c.req.valid('json')
          const namespace = ns(c.req.param('db'), q.schema)
          const r = await c.get('session').adapter.deleteRows(namespace, c.req.param('table'), body.keys)
          await recordGridChange(
            cfg.store.sharedItems,
            c.get('session').config,
            namespace,
            c.req.param('table'),
            'delete',
            r.affectedRows,
            [],
            logger
          )
          return c.json(r)
        }
      )
      .get('/databases/:db/export', validate('query', ExportQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const adapter = c.get('session').adapter
        const namespace = ns(c.req.param('db'), q.schema)
        const requested = decodeTableList(q.tables)
        // Everything by default, tables before views so a CREATE VIEW in the dump follows its base tables.
        // Requested names are checked up front: once the streamed body has started, a failure can only abort
        // the download (the browser reports "failed"); a JSON 404 at least never produces a partial file.
        const all = await adapter.listTables(namespace)
        const missing = requested.filter((name) => !all.some((t) => t.name === name))
        if (missing.length > 0) {
          return c.json(apiError('NOT_FOUND', `Unknown table(s): ${missing.join(', ')}`), 404)
        }
        const tables =
          requested.length > 0
            ? requested
            : [...all.filter((t) => t.kind === 'table'), ...all.filter((t) => t.kind !== 'table')].map((t) => t.name)
        if (SINGLE_TABLE_FORMATS.includes(q.format) && tables.length !== 1 && q.filePerTable !== '1') {
          return c.json(apiError('VALIDATION', 'CSV export needs exactly one table (or one file per table)'), 400)
        }
        // UPDATE / REPLACE find a row by its primary key: said before the download starts, not by cutting it short.
        if (q.format === 'sql') {
          const keyless = await keylessTables(adapter, namespace, all, tables, q)
          if (keyless.length > 0)
            return c.json(
              apiError(
                'VALIDATION',
                `These tables have no primary key, which the chosen statement type needs: ${keyless.join(', ')}`
              ),
              400
            )
        }
        const baseName = requested.length === 1 ? `${namespace.database}_${requested[0]}` : namespace.database
        const file = buildPackagedExport(adapter, namespace, tables, q, {
          server: c.get('session').config.host,
          baseName,
          everything: requested.length === 0,
          listing: all,
        })
        // Streamed so a large table is never held in memory. A failure mid-stream errors the response body
        // (the browser reports a failed download) instead of ending it normally, which would make a
        // truncated file look complete.
        return c.body(
          toReadableStream(file.body, (err) =>
            logger?.log('error', 'export.aborted', {
              requestId: c.get('requestId'),
              database: namespace.database,
              error: err instanceof Error ? err.message : String(err),
            })
          ),
          200,
          { 'content-type': file.contentType, 'content-disposition': contentDisposition(file.filename) }
        )
      })
      .post(
        '/databases/:db/import',
        bodyLimit({ maxSize: IMPORT_MAX_BYTES + 1024 * 1024 }),
        validate('form', ImportFormSchema),
        async (c) => {
          const form = c.req.valid('form')
          const body = await c.req.parseBody()
          const file = body.file
          if (!(file instanceof File)) return c.json(apiError('VALIDATION', 'A file is required'), 400)
          if (file.size > IMPORT_MAX_BYTES)
            return c.json(apiError('PAYLOAD_TOO_LARGE', `File exceeds ${IMPORT_MAX_BYTES} bytes`), 413)
          const adapter = c.get('session').adapter
          let prepared: PreparedImport
          try {
            prepared = prepareImport(new Uint8Array(await file.arrayBuffer()), form)
          } catch (err) {
            if (err instanceof ImportValidationError) return c.json(validationError(err), 400)
            throw err
          }
          return importResponse(c, adapter, ns(c.req.param('db'), form.schema), form, prepared)
        }
      )
      // Builds a SELECT from structured choices and returns it for the SQL tab; nothing but structure is read.
      .post('/databases/:db/query', validate('json', QueryBuilderRequestSchema), async (c) => {
        const { schema, ...spec } = c.req.valid('json')
        const result = await c.get('session').adapter.buildQuery(ns(c.req.param('db'), schema), spec)
        return c.json(result)
      })
      .post('/databases/:db/sql', validate('json', SqlRequestSchema), async (c) => {
        const body = c.req.valid('json')
        const results = await c.get('session').adapter.executeSql(ns(c.req.param('db'), body.schema), body.sql, {
          maxRows: body.maxRows,
          timeoutMs: body.timeoutMs,
          stopOnError: body.stopOnError,
          profile: body.profile,
          ...(body.queryId ? { queryId: body.queryId } : {}),
        })
        await recordStatements(
          cfg.store.sharedItems,
          c.get('session').config,
          ns(c.req.param('db'), body.schema),
          executed(results, c.get('session').adapter.dialect),
          c.get('session').adapter.dialect,
          logger
        )
        return c.json(results)
      })
      /** Same as POST /sql but streams one NDJSON line per statement as it completes. */
      .post('/databases/:db/sql/stream', validate('json', SqlRequestSchema), (c) => {
        const body = c.req.valid('json')
        const adapter = c.get('session').adapter
        const namespace = ns(c.req.param('db'), body.schema)
        // Always register the run so a client that disconnects mid-script gets its statement interrupted
        // instead of running to completion on an abandoned connection.
        const queryId = body.queryId ?? crypto.randomUUID()
        const encoder = new TextEncoder()
        let closed = false
        // Backpressure: a slow consumer must not make this process buffer every result set. Statement results
        // wait until the stream has room again (pull() resolves the gate).
        let gate: (() => void) | null = null
        let started = false
        // The script runs from the first pull(), not start(): the stream calls pull() again only after start()
        // settles, so awaiting the whole run there would deadlock the backpressure gate.
        const run = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
          const send = async (event: SqlStreamEvent) => {
            if (closed) return
            while (!closed && controller.desiredSize !== null && controller.desiredSize <= 0) {
              await new Promise<void>((resolve) => {
                gate = resolve
              })
            }
            if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          }
          // A statement longer than the connection's idle timeout would drop the stream: keep it warm.
          const heartbeat = setInterval(() => {
            if (!closed) controller.enqueue(encoder.encode('\n'))
          }, HEARTBEAT_MS)
          try {
            // Answered by the server itself once the script is done, just before its transaction is rolled back.
            let openTransaction = false
            const ran: StatementResult[] = []
            const results = await adapter.executeSql(namespace, body.sql, {
              maxRows: body.maxRows,
              timeoutMs: body.timeoutMs,
              stopOnError: body.stopOnError,
              profile: body.profile,
              queryId,
              onResult: (result, index) => {
                ran.push(result)
                return send({ type: 'result', index, result })
              },
              onTransactionOpen: (open) => {
                openTransaction = open
              },
            })
            // What ran inside a transaction left open is rolled back with it (executed() leaves it out).
            await recordStatements(
              cfg.store.sharedItems,
              c.get('session').config,
              namespace,
              executed(ran, adapter.dialect),
              adapter.dialect,
              logger
            )
            await send({
              type: 'done',
              statements: results.length,
              openTransaction,
            })
          } catch (err) {
            const { body } = toApiError(err)
            await send({
              type: 'fatal',
              message: body.message,
              code: body.code,
              ...(body.nativeCode ? { nativeCode: body.nativeCode } : {}),
            })
          } finally {
            clearInterval(heartbeat)
            if (!closed) {
              closed = true
              controller.close()
            }
          }
        }
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!started) {
              started = true
              void run(controller)
              return
            }
            gate?.()
            gate = null
          },
          async cancel() {
            // Consumer went away (tab closed, request aborted): stop the statement and drop further events.
            closed = true
            gate?.()
            gate = null
            await adapter.cancelQuery(queryId)
          },
        })
        return c.body(stream, 200, NDJSON_HEADERS)
      })
      .post('/databases/:db/sql/cancel', validate('json', SqlCancelRequestSchema), async (c) => {
        const cancelled = await c.get('session').adapter.cancelQuery(c.req.valid('json').queryId)
        return c.json({ cancelled })
      })
      .post('/databases/:db/ddl/preview', validate('json', DdlPreviewRequestSchema), async (c) => {
        const body = c.req.valid('json')
        const adapter = c.get('session').adapter
        const target = ns(c.req.param('db'), body.schema)
        let op = body.op
        // Caught here rather than by the server: PostgreSQL would silently truncate the name to 63 bytes.
        const long = tooLongIdentifier(op, adapter.dialect)
        if (long) return c.json(identifierTooLong(long), 400)
        // A data copy lists the insertable columns: generated columns cannot be written (INSERT ... SELECT *
        // would fail after the empty copy was already created, since DDL autocommits).
        if (op.op === 'copyTable' && adapter.dialect === 'postgres') {
          const schema = await adapter.describeTable(target, op.table)
          op = {
            ...op,
            columns: op.columns ?? schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name),
            identityColumns:
              op.identityColumns ??
              schema.columns.filter((col) => col.extra.startsWith('identity')).map((col) => col.name),
            // A renamed serial sequence (or CREATE SEQUENCE … OWNED BY) is not `serial` by name but pins the copy to
            // the source's sequence all the same: the owned sequences of the source name those columns.
            serialColumns:
              op.serialColumns ??
              (await ownedSequenceColumns(
                adapter,
                target,
                op.table,
                schema.columns.map((col) => col.name)
              )),
          }
        } else if (op.op === 'setDatabaseCollation' && op.applyToTables && op.tables === undefined) {
          // The tables as they are now, and on PostgreSQL their text columns: the preview lists every statement.
          const tables = (await adapter.listTables(target)).filter((t) => t.kind === 'table').map((t) => t.name)
          const columns: Record<string, { name: string; dataType: string }[]> = {}
          if (adapter.dialect === 'postgres')
            for (const table of tables)
              columns[table] = (await adapter.describeTable(target, table)).columns
                .filter((col) => /char|text|citext/i.test(col.dataType) && col.generated === null)
                .map((col) => ({ name: col.name, dataType: col.dataType }))
          op = { ...op, tables, ...(adapter.dialect === 'postgres' ? { columns } : {}) }
        } else if (op.op === 'copyTables' && op.withData && op.details === undefined) {
          // Each table as copyTable would get it: the insertable columns, and on PostgreSQL its sequences.
          const details: Record<string, { columns?: string[]; identityColumns?: string[]; serialColumns?: string[] }> =
            {}
          for (const table of op.tables) {
            const schema = await adapter.describeTable(target, table)
            const columns = schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name)
            details[table] =
              adapter.dialect === 'postgres'
                ? {
                    columns,
                    identityColumns: schema.columns
                      .filter((col) => col.extra.startsWith('identity'))
                      .map((col) => col.name),
                    serialColumns: await ownedSequenceColumns(
                      adapter,
                      target,
                      table,
                      schema.columns.map((col) => col.name)
                    ),
                  }
                : { columns }
          }
          op = { ...op, details }
        } else if (op.op === 'copyTable' && op.withData && op.columns === undefined) {
          const schema = await adapter.describeTable(target, op.table)
          op = { ...op, columns: schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name) }
        }
        if (op.op === 'renameDatabase' || op.op === 'copyDatabase') {
          try {
            op = await prepareDatabaseOp(adapter, target, op)
          } catch (err) {
            if (err instanceof DatabaseOpRefused)
              return c.json(apiError(err.code, err.message), err.code === 'NOT_FOUND' ? 404 : 400)
            throw err
          }
        }
        return c.json({ sql: adapter.ddl.build(target, op) })
      })
  )
}
