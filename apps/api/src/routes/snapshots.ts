import type { Namespace, SnapshotList } from '@tsmyadmin/shared'
import { SchemaQuerySchema, SnapshotCreateSchema } from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { apiError } from '../lib/errors.ts'
import { ImportValidationError } from '../lib/import.ts'
import { validationError } from '../lib/import-run.ts'
import type { Logger } from '../lib/logging.ts'
import {
  previewRestore,
  restoreSnapshot,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_COUNT,
  SnapshotError,
  SnapshotStore,
  takeSnapshot,
} from '../lib/snapshots.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'

const IdParamSchema = z.object({ db: z.string().min(1), id: z.string().min(1).max(20) })

/**
 * Snapshots of a database, for trying a migration or a seed and going back: take one, list them, put one back,
 * delete one. They are kept in this process's memory, per account and database. Putting one back is run from the
 * snapshot the server holds (its dump is too large to round-trip through a preview), after the same kind of
 * preview the account operations have: what will be dropped, and how much will run.
 */
export function snapshotRoutes(cfg: SessionConfig, logger: Logger, store: SnapshotStore = new SnapshotStore()) {
  const target = (c: Context<AppEnv>, schema: string | undefined): { ns: Namespace; scope: string } => {
    const db = c.req.param('db') ?? ''
    const ns: Namespace = schema ? { database: db, schema } : { database: db }
    return { ns, scope: SnapshotStore.scope(c.get('session').config, ns) }
  }
  const listOf = (scope: string): SnapshotList => ({
    snapshots: store.list(scope),
    maxCount: SNAPSHOT_MAX_COUNT,
    maxBytes: SNAPSHOT_MAX_BYTES,
  })
  const path = '/databases/:db/snapshots'
  return new Hono<AppEnv>()
    .use(path, requireSession(cfg))
    .use(`${path}/:id`, requireSession(cfg))
    .use(`${path}/:id/restore`, requireSession(cfg))
    .use(`${path}/:id/restore/preview`, requireSession(cfg))
    .get(path, validate('query', SchemaQuerySchema), (c) => {
      const { scope } = target(c, c.req.valid('query').schema)
      return c.json(listOf(scope))
    })
    .post(path, validate('query', SchemaQuerySchema), validate('json', SnapshotCreateSchema), async (c) => {
      const { ns, scope } = target(c, c.req.valid('query').schema)
      try {
        await takeSnapshot(store, scope, c.get('session').adapter, ns, c.req.valid('json').name)
      } catch (err) {
        if (err instanceof SnapshotError) return c.json(apiError('VALIDATION', err.message), 400)
        throw err
      }
      logger.log('info', 'snapshot.taken', { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
      return c.json(listOf(scope))
    })
    .delete(`${path}/:id`, validate('param', IdParamSchema), validate('query', SchemaQuerySchema), (c) => {
      const { scope } = target(c, c.req.valid('query').schema)
      if (!store.remove(scope, c.req.valid('param').id)) return c.json(apiError('NOT_FOUND', 'Unknown snapshot'), 404)
      return c.json(listOf(scope))
    })
    .get(
      `${path}/:id/restore/preview`,
      validate('param', IdParamSchema),
      validate('query', SchemaQuerySchema),
      async (c) => {
        const { ns, scope } = target(c, c.req.valid('query').schema)
        const held = store.get(scope, c.req.valid('param').id)
        if (!held) return c.json(apiError('NOT_FOUND', 'Unknown snapshot'), 404)
        return c.json(await previewRestore(c.get('session').adapter, ns, held))
      }
    )
    .post(`${path}/:id/restore`, validate('param', IdParamSchema), validate('query', SchemaQuerySchema), async (c) => {
      const { ns, scope } = target(c, c.req.valid('query').schema)
      const held = store.get(scope, c.req.valid('param').id)
      if (!held) return c.json(apiError('NOT_FOUND', 'Unknown snapshot'), 404)
      try {
        const result = await restoreSnapshot(c.get('session').adapter, ns, held, crypto.randomUUID())
        logger.log('info', 'snapshot.restored', {
          database: ns.database,
          ...(ns.schema ? { schema: ns.schema } : {}),
          statements: result.statements,
          failed: result.failed,
        })
        return c.json(result)
      } catch (err) {
        if (err instanceof ImportValidationError) return c.json(validationError(err), 400)
        throw err
      }
    })
}
