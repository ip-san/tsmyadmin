import {
  PASSWORD_MASK,
  type StatementResult,
  UserGrantsQuerySchema,
  type UserOp,
  UserOpRequestSchema,
} from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { identifierTooLong, tooLongIdentifier } from '../lib/identifiers.ts'
import { redactInLogs } from '../lib/request-context.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

export function userRoutes(cfg: SessionConfig) {
  return new Hono<AppEnv>()
    .use('/users', requireSession(cfg))
    .use('/users/*', requireSession(cfg))
    .get('/users', async (c) => c.json(await c.get('session').adapter.listUsers()))
    .get('/users/grants', validate('query', UserGrantsQuerySchema), async (c) => {
      const { database, schema, ...user } = c.req.valid('query')
      const ns = database ? { database, ...(schema ? { schema } : {}) } : undefined
      const statements = await c.get('session').adapter.showGrants(user, ns)
      return c.json({ statements })
    })
    .post('/users/preview', validate('json', UserOpRequestSchema), (c) => {
      const { op } = c.req.valid('json')
      const long = tooLongIdentifier({ user: op.user.name }, c.get('session').adapter.dialect)
      if (long) return c.json(identifierTooLong(long), 400)
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
      // The UI previews first; a direct call must not create a role under a silently truncated name.
      const long = tooLongIdentifier({ user: op.user.name }, adapter.dialect)
      if (long) return c.json(identifierTooLong(long), 400)
      const statements = adapter.users.build(op)
      if ('password' in op) {
        // The audit line carries the SQL text, where the password appears literal-encoded (quotes doubled, backslashes
        // escaped), so register both the raw value and its encoded form.
        redactInLogs(op.password)
        redactInLogs(adapter.exporter.literal(op.password).slice(1, -1))
      }
      // One connection for the whole operation; executeSql splits the script and stops at the first error.
      // PostgreSQL role / grant statements are transactional: all of them or none (a failing third GRANT must not
      // leave the first two in place). MySQL account statements commit implicitly, so they run as they are.
      const transactional = adapter.dialect === 'postgres' && statements.length > 1
      const script = [
        ...(transactional ? ['BEGIN'] : []),
        ...statements.map((s) => s.sql),
        ...(transactional ? ['COMMIT'] : []),
      ].join(';\n')
      const all = await adapter.executeSql(adapter.users.namespace(op, adapter.serverNamespace), script, {
        maxRows: 1,
        timeoutMs: 30_000,
        stopOnError: true,
      })
      // The wrapper statements are not the user's: only their own show, in the masked display form — except a
      // COMMIT that failed, which is the error the user must see (its SQL is shown as the wrapper's).
      const results = transactional ? all.slice(1, 1 + statements.length) : all
      const commit = transactional ? all[1 + statements.length] : undefined
      const rolledBack = transactional && all.some((r) => r.kind === 'error')
      const shown = [...results, ...(commit?.kind === 'error' ? [commit] : [])]
      const encoded = 'password' in op && op.password !== '' ? adapter.exporter.literal(op.password).slice(1, -1) : ''
      return c.json({
        results: shown.map((r, i) => redactPassword({ ...r, sql: statements[i]?.display ?? r.sql }, op, encoded)),
        rolledBack,
      })
    })
}

/**
 * Never echo passwords back. The SQL shown is the masked `display` form, and error messages are scrubbed too:
 * MySQL syntax errors quote the failing fragment (`... near 'IDENTIFIED BY 'x''`).
 */
function redactPassword(result: StatementResult, op: UserOp, encoded: string): StatementResult {
  const password = 'password' in op ? op.password : ''
  if (password === '' || result.kind !== 'error') return result
  // Both the raw value and its literal-encoded form (quotes doubled, backslashes escaped), like the audit log.
  let message = result.message.split(password).join(PASSWORD_MASK)
  if (encoded && encoded !== password) message = message.split(encoded).join(PASSWORD_MASK)
  return { ...result, message }
}
