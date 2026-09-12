import { KillQuerySchema, ProcessIdSchema } from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

export function serverRoutes(cfg: SessionConfig) {
  return new Hono<AppEnv>()
    .use('/server/*', requireSession(cfg))
    .get('/server/info', async (c) => c.json(await c.get('session').adapter.serverInfo()))
    .get('/server/variables', async (c) => c.json(await c.get('session').adapter.listVariables()))
    .get('/server/status', async (c) => c.json(await c.get('session').adapter.listStatus()))
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
}
