import type { Namespace, TrackedTable, TrackedVersion, TrackingState } from '@tsmyadmin/shared'
import {
  DEFAULT_TRACK_KINDS,
  SchemaQuerySchema,
  TRACKING_DEFINITION_MAX,
  TrackedVersionSchema,
  TrackingKindsRequestSchema,
  trackedVersionKey,
} from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { apiError } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
import { setTrackedKinds, trackedKinds, trackedStatements } from '../lib/tracking-log.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'
import type { SavedItem } from '../session/store.ts'
import { sessionInfo } from '../session/store.ts'

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const VersionBodySchema = TrackedVersionSchema.omit({ id: true, at: true })

/**
 * phpMyAdmin's change tracking, as snapshots of a table's definition: record one, list them, compare any two (or
 * the latest with now), stop tracking. Kept for every account of the server.
 *
 * Every call first reads the table's definition through the caller's own session, so an account that cannot see
 * the table can neither read its history nor change it. The definition stored is the one the server printed, never
 * text from the request.
 */
export function trackingRoutes(cfg: SessionConfig, logger: Logger) {
  const unsupported = (c: Context) => c.json(apiError('UNSUPPORTED', 'Tracking needs a persistent session store'), 400)
  /** The table's definition now, through the caller's own privileges (throws when it cannot be read). */
  const definition = async (c: Context<AppEnv>, ns: Namespace, table: string) =>
    (await c.get('session').adapter.showCreateTable(ns, table)).join(';\n')
  const versions = async (c: Context<AppEnv>, ns: Namespace, table: string): Promise<TrackedVersion[]> => {
    const items: SavedItem[] = (await cfg.store.sharedItems?.list(c.get('session').config, 'tracking')) ?? []
    return items
      .flatMap((item) => {
        const body = VersionBodySchema.safeParse(safeJson(item.body))
        return body.success ? [{ ...body.data, id: item.id, at: item.at }] : []
      })
      .filter((v) => v.database === ns.database && (v.schema ?? '') === (ns.schema ?? '') && v.table === table)
      .sort((a, b) => a.version - b.version)
  }
  /**
   * The whole state. The statement log only for a viewer who can read the table's rows: a recorded statement may
   * hold row values, and the log is shared by every account of the server.
   */
  const stateOf = async (c: Context<AppEnv>, ns: Namespace, table: string, current: string): Promise<TrackingState> => {
    const session = c.get('session')
    const store = cfg.store.sharedItems
    const list = await versions(c, ns, table)
    if (!store || list.length === 0) return { versions: list, current, kinds: [], log: [] }
    const kinds = (await trackedKinds(store, session.config, ns)).get(table)?.kinds ?? []
    const readable = await session.adapter
      .browseRows(ns, table, { offset: 0, limit: 1, sort: [], filters: [] })
      .then(() => true)
      .catch(() => false)
    const log = readable
      ? (await trackedStatements(store, session.config, ns, table)).map(({ storeId: _, ...e }) => e)
      : null
    return { versions: list, current, kinds, log }
  }
  const target = (c: Context<AppEnv>, schema: string | undefined) => {
    const db = c.req.param('db') ?? ''
    return { ns: schema ? { database: db, schema } : { database: db }, table: c.req.param('table') ?? '' }
  }
  const path = '/databases/:db/tables/:table/tracking'
  return (
    new Hono<AppEnv>()
      .use(path, requireSession(cfg))
      .use(`${path}/kinds`, requireSession(cfg))
      .use('/databases/:db/tracking', requireSession(cfg))
      // Every tracked table of a database / schema (phpMyAdmin's database-level Tracking), among the tables the
      // caller can see.
      .get('/databases/:db/tracking', validate('query', SchemaQuerySchema), async (c) => {
        const session = c.get('session')
        const store = cfg.store.sharedItems
        const schema = c.req.valid('query').schema
        const ns: Namespace = schema ? { database: c.req.param('db'), schema } : { database: c.req.param('db') }
        if (!store) return c.json<TrackedTable[]>([])
        const visible = new Set((await session.adapter.listTables(ns)).map((t) => t.name))
        const kinds = await trackedKinds(store, session.config, ns)
        const byTable = new Map<string, TrackedVersion[]>()
        for (const item of await store.list(session.config, 'tracking')) {
          const body = VersionBodySchema.safeParse(safeJson(item.body))
          if (!body.success) continue
          const v = { ...body.data, id: item.id, at: item.at }
          if (v.database !== ns.database || (v.schema ?? '') !== (ns.schema ?? '') || !visible.has(v.table)) continue
          byTable.set(v.table, [...(byTable.get(v.table) ?? []), v])
        }
        const list: TrackedTable[] = [...byTable.entries()].map(([table, vs]) => {
          const latest = vs.reduce((a, b) => (b.version > a.version ? b : a))
          return {
            table,
            versions: vs.length,
            latest: latest.version,
            at: latest.at,
            kinds: kinds.get(table)?.kinds ?? [],
          }
        })
        return c.json(list.sort((a, b) => a.table.localeCompare(b.table)))
      })
      .get(path, validate('query', SchemaQuerySchema), async (c) => {
        const { ns, table } = target(c, c.req.valid('query').schema)
        const current = await definition(c, ns, table)
        return c.json<TrackingState>(await stateOf(c, ns, table, current))
      })
      // Records the definition as it is now, as the next version — unless it is what the latest version holds.
      .post(path, validate('query', SchemaQuerySchema), async (c) => {
        const store = cfg.store.sharedItems
        if (!store) return unsupported(c)
        const session = c.get('session')
        const { ns, table } = target(c, c.req.valid('query').schema)
        const current = await definition(c, ns, table)
        const known = await versions(c, ns, table)
        const latest = known.at(-1)
        if (latest?.definition === current) return c.json<TrackingState>(await stateOf(c, ns, table, current))
        if (current.length > TRACKING_DEFINITION_MAX) {
          return c.json(
            apiError('UNSUPPORTED', `The definition is longer than ${TRACKING_DEFINITION_MAX} characters to keep`),
            400
          )
        }
        const body = {
          database: ns.database,
          ...(ns.schema ? { schema: ns.schema } : {}),
          table,
          version: (latest?.version ?? 0) + 1,
          definition: current,
          by: session.config.user,
        }
        await store.save(session.config, 'tracking', trackedVersionKey(body), JSON.stringify(body))
        // Tracking starts with the first version, recording the definition changes by default.
        if (!latest) await setTrackedKinds(store, session.config, ns, table, DEFAULT_TRACK_KINDS)
        logger.log('info', 'tracking.record', {
          requestId: c.get('requestId'),
          ...sessionInfo(session),
          database: ns.database,
          table,
          version: body.version,
        })
        return c.json<TrackingState>(await stateOf(c, ns, table, current))
      })
      // Which statement kinds the table records (phpMyAdmin's "Tracking statements").
      .put(
        `${path}/kinds`,
        validate('query', SchemaQuerySchema),
        validate('json', TrackingKindsRequestSchema),
        async (c) => {
          const store = cfg.store.sharedItems
          if (!store) return unsupported(c)
          const session = c.get('session')
          const { ns, table } = target(c, c.req.valid('query').schema)
          const current = await definition(c, ns, table)
          if ((await versions(c, ns, table)).length === 0)
            return c.json(apiError('VALIDATION', 'The table is not tracked'), 400)
          await setTrackedKinds(store, session.config, ns, table, [...new Set(c.req.valid('json').kinds)])
          logger.log('info', 'tracking.kinds', {
            requestId: c.get('requestId'),
            ...sessionInfo(session),
            database: ns.database,
            table,
          })
          return c.json<TrackingState>(await stateOf(c, ns, table, current))
        }
      )
      // Stops tracking: every version of this table goes.
      .delete(path, validate('query', SchemaQuerySchema), async (c) => {
        const store = cfg.store.sharedItems
        if (!store) return unsupported(c)
        const session = c.get('session')
        const { ns, table } = target(c, c.req.valid('query').schema)
        const current = await definition(c, ns, table)
        for (const v of await versions(c, ns, table)) await store.remove(session.config, 'tracking', v.id)
        const conf = (await trackedKinds(store, session.config, ns)).get(table)
        if (conf) await store.remove(session.config, 'trackconf', conf.id)
        for (const e of await trackedStatements(store, session.config, ns, table))
          await store.remove(session.config, 'tracklog', e.storeId)
        logger.log('info', 'tracking.stop', {
          requestId: c.get('requestId'),
          ...sessionInfo(session),
          database: ns.database,
          table,
        })
        return c.json<TrackingState>({ versions: [], current, kinds: [], log: [] })
      })
  )
}
