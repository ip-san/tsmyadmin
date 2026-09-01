import {
  BrowseQuerySchema,
  DdlPreviewRequestSchema,
  DeleteRowsRequestSchema,
  ExportQuerySchema,
  IMPORT_MAX_BYTES,
  ImportFormSchema,
  InsertRowRequestSchema,
  type Namespace,
  parseBrowseQuery,
  SchemaQuerySchema,
  SqlRequestSchema,
  UpdateRowRequestSchema,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { apiError } from '../lib/errors.ts'
import { buildExport, contentDisposition } from '../lib/export.ts'
import { ImportValidationError, importCsv, importSql } from '../lib/import.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

function ns(database: string, schema?: string): Namespace {
  return schema ? { database, schema } : { database }
}

export function databaseRoutes(cfg: SessionConfig) {
  return new Hono<AppEnv>()
    .use('/databases/*', requireSession(cfg))
    .use('/databases', requireSession(cfg))
    .get('/databases', async (c) => c.json(await c.get('session').adapter.listDatabases()))
    .get('/databases/:db/schemas', async (c) => c.json(await c.get('session').adapter.listSchemas(c.req.param('db'))))
    .get('/databases/:db/tables', validate('query', SchemaQuerySchema), async (c) => {
      const q = c.req.valid('query')
      return c.json(await c.get('session').adapter.listTables(ns(c.req.param('db'), q.schema)))
    })
    .get('/databases/:db/tables/:table/structure', validate('query', SchemaQuerySchema), async (c) => {
      const q = c.req.valid('query')
      return c.json(await c.get('session').adapter.describeTable(ns(c.req.param('db'), q.schema), c.req.param('table')))
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
      const requested = (q.tables ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      const tables =
        requested.length > 0
          ? requested
          : (await adapter.listTables(namespace)).filter((t) => t.kind === 'table').map((t) => t.name)
      if (q.format === 'csv' && tables.length !== 1)
        return c.json(apiError('VALIDATION', 'CSV export needs exactly one table'), 400)
      const baseName = requested.length === 1 ? `${namespace.database}_${requested[0]}` : namespace.database
      const file = await buildExport(adapter, namespace, tables, q, baseName)
      return c.body(file.body, 200, {
        'content-type': file.contentType,
        'content-disposition': contentDisposition(file.filename),
      })
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
          return c.json(apiError('VALIDATION', `File exceeds ${IMPORT_MAX_BYTES} bytes`), 400)
        const text = await file.text()
        const adapter = c.get('session').adapter
        const namespace = ns(c.req.param('db'), form.schema)
        try {
          const result =
            form.format === 'sql'
              ? await importSql(adapter, namespace, text, form.stopOnError === '1')
              : await importCsv(adapter, namespace, form, text)
          return c.json(result)
        } catch (err) {
          if (err instanceof ImportValidationError) return c.json(apiError('VALIDATION', err.message), 400)
          throw err
        }
      }
    )
    .post('/databases/:db/sql', validate('json', SqlRequestSchema), async (c) => {
      const body = c.req.valid('json')
      const results = await c.get('session').adapter.executeSql(ns(c.req.param('db'), body.schema), body.sql, {
        maxRows: body.maxRows,
        timeoutMs: body.timeoutMs,
        stopOnError: body.stopOnError,
      })
      return c.json(results)
    })
    .post('/databases/:db/ddl/preview', validate('json', DdlPreviewRequestSchema), (c) => {
      const body = c.req.valid('json')
      const sql = c.get('session').adapter.ddl.build(ns(c.req.param('db'), body.schema), body.op)
      return c.json({ sql })
    })
}
