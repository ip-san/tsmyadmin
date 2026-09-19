import { buildReplicationOp } from '@tsmyadmin/adapter'
import {
  DiagnosticKindSchema,
  DiagnosticQuerySchema,
  decodeTableList,
  IMPORT_MAX_BYTES,
  ImportFormSchema,
  KillQuerySchema,
  PASSWORD_MASK,
  ProcessIdSchema,
  ReplicationOpRequestSchema,
  ServerCatalogKindSchema,
  ServerExportQuerySchema,
  type StatementResult,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { apiError } from '../lib/errors.ts'
import { contentDisposition, toReadableStream } from '../lib/export.ts'
import { buildServerExport, keylessTables } from '../lib/export-package.ts'
import { ImportValidationError } from '../lib/import.ts'
import { importResponse, type PreparedImport, prepareImport, validationError } from '../lib/import-run.ts'
import type { Logger } from '../lib/logging.ts'
import { redactInLogs } from '../lib/request-context.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

export function serverRoutes(cfg: SessionConfig, logger?: Logger) {
  return (
    new Hono<AppEnv>()
      .use('/server/*', requireSession(cfg))
      .get('/server/info', async (c) => c.json(await c.get('session').adapter.serverInfo()))
      .get('/server/variables', async (c) => c.json(await c.get('session').adapter.listVariables()))
      .get('/server/status', async (c) => c.json(await c.get('session').adapter.listStatus()))
      .get('/server/replication', async (c) => c.json(await c.get('session').adapter.replicationInfo()))
      // Starting, stopping, skipping and pointing the replica at a source: shown before it runs, the password masked.
      .post('/server/replication/preview', validate('json', ReplicationOpRequestSchema), async (c) => {
        const adapter = c.get('session').adapter
        const { op } = c.req.valid('json')
        const mariadb = /mariadb/i.test((await adapter.serverInfo()).version)
        return c.json({ sql: buildReplicationOp(adapter.dialect, mariadb, op).map((s) => s.display) })
      })
      .post('/server/replication/execute', validate('json', ReplicationOpRequestSchema), async (c) => {
        const adapter = c.get('session').adapter
        const { op } = c.req.valid('json')
        const mariadb = /mariadb/i.test((await adapter.serverInfo()).version)
        const statements = buildReplicationOp(adapter.dialect, mariadb, op)
        const password = op.op === 'changeSource' ? op.password : ''
        const encoded = password === '' ? '' : adapter.exporter.literal(password).slice(1, -1)
        if (password !== '') {
          redactInLogs(password)
          redactInLogs(encoded)
        }
        const results = await adapter.executeSql(adapter.serverNamespace, statements.map((s) => s.sql).join(';\n'), {
          maxRows: 1,
          timeoutMs: 30_000,
          stopOnError: true,
        })
        // Shown in the masked form, and an error that quotes the failing fragment is scrubbed of the password too.
        const scrub = (message: string) =>
          password === '' ? message : message.split(password).join(PASSWORD_MASK).split(encoded).join(PASSWORD_MASK)
        return c.json({
          results: results.map((r, i): StatementResult => {
            const shown = { ...r, sql: statements[i]?.display ?? r.sql }
            return shown.kind === 'error' ? { ...shown, message: scrub(shown.message) } : shown
          }),
          rolledBack: false,
        })
      })
      .get(
        '/server/diagnostics/:kind',
        validate('param', z.object({ kind: DiagnosticKindSchema })),
        validate('query', DiagnosticQuerySchema),
        async (c) => c.json(await c.get('session').adapter.diagnostics(c.req.valid('param').kind, c.req.valid('query')))
      )
      // A dump of several databases (or schemas), and a script run at the server's level (CREATE DATABASE, USE).
      .get('/server/export', validate('query', ServerExportQuerySchema), async (c) => {
        const q = c.req.valid('query')
        const adapter = c.get('session').adapter
        const wanted = decodeTableList(q.targets)
        // MySQL: databases; PostgreSQL: the schemas of the database this session is connected to.
        const known =
          adapter.dialect === 'mysql'
            ? (await adapter.listDatabases()).map((d) => d.name)
            : await adapter.listSchemas(adapter.serverNamespace.database)
        const missing = wanted.filter((name) => !known.includes(name))
        if (wanted.length === 0 || missing.length > 0)
          return c.json(apiError('NOT_FOUND', `Unknown target(s): ${missing.join(', ') || '(none given)'}`), 404)
        const namespaces = wanted.map((name) =>
          adapter.dialect === 'mysql'
            ? { database: name }
            : { database: adapter.serverNamespace.database, schema: name }
        )
        // UPDATE / REPLACE need a primary key: said before the download starts, not by cutting it short.
        const keyless: string[] = []
        for (const target of namespaces) {
          const listing = await adapter.listTables(target)
          for (const name of await keylessTables(
            adapter,
            target,
            listing,
            listing.map((t) => t.name),
            q
          ))
            keyless.push(`${target.schema ?? target.database}.${name}`)
        }
        if (keyless.length > 0)
          return c.json(
            apiError(
              'VALIDATION',
              `These tables have no primary key, which the chosen statement type needs: ${keyless.join(', ')}`
            ),
            400
          )
        const file = buildServerExport(adapter, namespaces, q, { server: c.get('session').config.host })
        const onError = (err: unknown) =>
          logger?.log('error', 'export.aborted', {
            requestId: c.get('requestId'),
            error: err instanceof Error ? err.message : String(err),
          })
        return c.body(toReadableStream(file.body, onError), 200, {
          'content-type': file.contentType,
          'content-disposition': contentDisposition(file.filename),
        })
      })
      .post(
        '/server/import',
        bodyLimit({ maxSize: IMPORT_MAX_BYTES + 1024 * 1024 }),
        validate('form', ImportFormSchema),
        async (c) => {
          const form = c.req.valid('form')
          if (form.format !== 'sql')
            return c.json(apiError('VALIDATION', 'The server-level import runs SQL scripts'), 400)
          const file = (await c.req.parseBody()).file
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
          return importResponse(c, adapter, adapter.serverNamespace, form, prepared)
        }
      )
      .get('/server/catalog/:kind', validate('param', z.object({ kind: ServerCatalogKindSchema })), async (c) =>
        c.json(await c.get('session').adapter.serverCatalog(c.req.valid('param').kind))
      )
      .get('/server/processes', async (c) => c.json(await c.get('session').adapter.listProcesses()))
      .post(
        '/server/processes/:id/kill',
        validate('param', ProcessIdSchema),
        validate('query', KillQuerySchema),
        async (c) => {
          await c.get('session').adapter.killProcess(c.req.valid('param').id, c.req.valid('query').mode)
          return c.json({ ok: true })
        }
      )
  )
}
