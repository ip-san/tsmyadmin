import { type Namespace, UserOpRequestSchema, UserRefSchema } from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'
import type { Session } from '../session/store.ts'

/** Namespace for server-level statements: MySQL information_schema (readable by all), PostgreSQL the login database. */
function serverDatabase(session: Session): string {
  return session.config.dialect === 'mysql' ? 'information_schema' : (session.config.database ?? 'postgres')
}

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
      return c.json({ sql: c.get('session').adapter.users.build(op, { mask: true }) })
    })
    .post('/users/execute', validate('json', UserOpRequestSchema), async (c) => {
      const { op } = c.req.valid('json')
      const session = c.get('session')
      const adapter = session.adapter
      const target: Namespace = adapter.users.namespace(op, serverDatabase(session))
      const statements = adapter.users.build(op)
      const results = []
      for (const sql of statements) {
        const r = await adapter.executeSql(target, sql, { maxRows: 1, timeoutMs: 30_000, stopOnError: true })
        results.push(...r)
        if (r.some((x) => x.kind === 'error')) break
      }
      // Never echo passwords back: statements containing them are replaced by their masked form.
      const masked = adapter.users.build(op, { mask: true })
      return c.json(results.map((r, i) => ({ ...r, sql: masked[i] ?? masked[masked.length - 1] ?? '' })))
    })
}
