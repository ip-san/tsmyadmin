import {
  BrowseQuerySchema,
  DdlPreviewRequestSchema,
  DeleteRowsRequestSchema,
  InsertRowRequestSchema,
  type Namespace,
  parseBrowseQuery,
  SchemaQuerySchema,
  SqlRequestSchema,
  UpdateRowRequestSchema,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { apiError } from '../lib/errors.ts'
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
