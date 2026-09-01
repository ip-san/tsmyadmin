import { PASSWORD_MASK, type StatementResult, type UserOp, UserOpRequestSchema, UserRefSchema } from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

export function userRoutes(cfg: SessionConfig) {
  return new Hono<AppEnv>()
    .use('/users', requireSession(cfg))
    .use('/users/*', requireSession(cfg))
    .get('/users', async (c) => c.json(await c.get('session').adapter.listUsers()))
    .get('/users/grants', validate('query', UserRefSchema), async (c) => {
      const statements = await c.get('session').adapter.showGrants(c.req.valid('query'))
      return c.json({ statements })
    })
    .post('/users/preview', validate('json', UserOpRequestSchema), (c) => {
      const { op } = c.req.valid('json')
      return c.json({
        sql: c
          .get('session')
          .adapter.users.build(op)
          .map((s) => s.display),
      })
    })
    .post('/users/execute', validate('json', UserOpRequestSchema), async (c) => {
      const { op } = c.req.valid('json')
      const adapter = c.get('session').adapter
      const statements = adapter.users.build(op)
      // One connection for the whole operation; executeSql splits the script and stops at the first error.
      const results = await adapter.executeSql(
        adapter.users.namespace(op, adapter.serverNamespace),
        statements.map((s) => s.sql).join(';\n'),
        { maxRows: 1, timeoutMs: 30_000, stopOnError: true }
      )
      return c.json(results.map((r, i) => redactPassword({ ...r, sql: statements[i]?.display ?? '' }, op)))
    })
}

/**
 * Never echo passwords back. The SQL shown is the masked `display` form, and error messages are scrubbed too:
 * MySQL syntax errors quote the failing fragment (`... near 'IDENTIFIED BY 'x''`).
 */
function redactPassword(result: StatementResult, op: UserOp): StatementResult {
  const password = 'password' in op ? op.password : ''
  if (password === '' || result.kind !== 'error') return result
  return { ...result, message: result.message.split(password).join(PASSWORD_MASK) }
}
