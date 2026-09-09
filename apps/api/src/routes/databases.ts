import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import {
  type ApiError,
  BrowseQuerySchema,
  DdlPreviewRequestSchema,
  DeleteRowsRequestSchema,
  decodeTableList,
  ExportQuerySchema,
  IMPORT_MAX_BYTES,
  type ImportEvent,
  ImportFormSchema,
  InsertRowRequestSchema,
  isGeneratedColumn,
  type Namespace,
  parseBrowseQuery,
  RoutineDefinitionQuerySchema,
  SchemaQuerySchema,
  SqlCancelRequestSchema,
  SqlRequestSchema,
  type SqlStreamEvent,
  TriggerQuerySchema,
  UpdateRowRequestSchema,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { apiError, toApiError } from '../lib/errors.ts'
import { buildExport, contentDisposition, toReadableStream } from '../lib/export.ts'
import { identifierTooLong, tooLongIdentifier } from '../lib/identifiers.ts'
import { decodeUpload, ImportValidationError, importCsv, importSql } from '../lib/import.ts'
import type { Logger } from '../lib/logging.ts'
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

function validationError(err: ImportValidationError): ApiError {
  return { ...apiError('VALIDATION', err.message), reason: err.reason, params: err.params }
}

export function databaseRoutes(cfg: SessionConfig, logger?: Logger) {
  return (
    new Hono<AppEnv>()
      .use('/databases/*', requireSession(cfg))
      .use('/databases', requireSession(cfg))
      .get('/databases', async (c) => c.json(await c.get('session').adapter.listDatabases()))
      .get('/databases/:db/schemas', async (c) => c.json(await c.get('session').adapter.listSchemas(c.req.param('db'))))
      .get('/databases/:db/tables', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        return c.json(await c.get('session').adapter.listTables(ns(c.req.param('db'), q.schema)))
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
      .get('/databases/:db/tables/:table/create', validate('query', SchemaQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const sql = await c
          .get('session')
          .adapter.showCreateTable(ns(c.req.param('db'), q.schema), c.req.param('table'))
        return c.json({ sql })
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
      .post(
        '/databases/:db/tables/:table/rows',
        validate('query', SchemaQuerySchema),
        validate('json', InsertRowRequestSchema),
        async (c) => {
          const q = c.req.valid('query')
          const body = c.req.valid('json')
          const r = await c
            .get('session')
            .adapter.insertRow(ns(c.req.param('db'), q.schema), c.req.param('table'), body.values)
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
          const r = await c
            .get('session')
            .adapter.updateRow(ns(c.req.param('db'), q.schema), c.req.param('table'), body.key, body.values)
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
          const r = await c
            .get('session')
            .adapter.deleteRows(ns(c.req.param('db'), q.schema), c.req.param('table'), body.keys)
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
        if (q.format === 'csv' && tables.length !== 1) {
          return c.json(apiError('VALIDATION', 'CSV export needs exactly one table'), 400)
        }
        const baseName = requested.length === 1 ? `${namespace.database}_${requested[0]}` : namespace.database
        const file = buildExport(adapter, namespace, tables, q, baseName, requested.length === 0, all)
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
          let text: string
          try {
            text = decodeUpload(new Uint8Array(await file.arrayBuffer()))
          } catch (err) {
            if (err instanceof ImportValidationError) return c.json(validationError(err), 400)
            throw err
          }
          const adapter = c.get('session').adapter
          const namespace = ns(c.req.param('db'), form.schema)
          // The run streams NDJSON (progress, then the result): a long import shows where it is, and a client that
          // goes away cancels the statement instead of leaving it to run to the end on an abandoned connection.
          const queryId = form.queryId ?? crypto.randomUUID()
          const encoder = new TextEncoder()
          let closed = false
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (event: ImportEvent) => {
                if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
              }
              const heartbeat = setInterval(() => {
                if (!closed) controller.enqueue(encoder.encode('\n'))
              }, HEARTBEAT_MS)
              try {
                const result =
                  form.format === 'sql'
                    ? await importSql(adapter, namespace, text, {
                        stopOnError: form.stopOnError === '1',
                        ignoreForeignKeys: form.ignoreForeignKeys === '1',
                        singleTransaction: form.singleTransaction === '1',
                        queryId,
                        onProgress: (done, total) => send({ type: 'progress', done, total }),
                      })
                    : await importCsv(adapter, namespace, form, text)
                send({ type: 'result', result })
              } catch (err) {
                send({
                  type: 'fatal',
                  error: err instanceof ImportValidationError ? validationError(err) : toApiError(err).body,
                })
              } finally {
                clearInterval(heartbeat)
                if (!closed) {
                  closed = true
                  controller.close()
                }
              }
            },
            async cancel() {
              closed = true
              await adapter.cancelQuery(queryId)
            },
          })
          return c.body(stream, 200, NDJSON_HEADERS)
        }
      )
      .post('/databases/:db/sql', validate('json', SqlRequestSchema), async (c) => {
        const body = c.req.valid('json')
        const results = await c.get('session').adapter.executeSql(ns(c.req.param('db'), body.schema), body.sql, {
          maxRows: body.maxRows,
          timeoutMs: body.timeoutMs,
          stopOnError: body.stopOnError,
          ...(body.queryId ? { queryId: body.queryId } : {}),
        })
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
            const results = await adapter.executeSql(namespace, body.sql, {
              maxRows: body.maxRows,
              timeoutMs: body.timeoutMs,
              stopOnError: body.stopOnError,
              queryId,
              onResult: (result, index) => send({ type: 'result', index, result }),
              onTransactionOpen: (open) => {
                openTransaction = open
              },
            })
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
        } else if (op.op === 'copyTable' && op.withData && op.columns === undefined) {
          const schema = await adapter.describeTable(target, op.table)
          op = { ...op, columns: schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name) }
        }
        return c.json({ sql: adapter.ddl.build(target, op) })
      })
  )
}
