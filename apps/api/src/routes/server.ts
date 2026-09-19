import { buildReplicationOp } from '@tsmyadmin/adapter'
import {
  DiagnosticKindSchema,
  DiagnosticQuerySchema,
  KillQuerySchema,
  PASSWORD_MASK,
  ProcessIdSchema,
  ReplicationOpRequestSchema,
  ServerCatalogKindSchema,
  type StatementResult,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { redactInLogs } from '../lib/request-context.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

export function serverRoutes(cfg: SessionConfig) {
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
