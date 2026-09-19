import type { Namespace, TrackedVersion, TrackingState } from '@tsmyadmin/shared'
import { SchemaQuerySchema, TRACKING_DEFINITION_MAX, TrackedVersionSchema, trackedVersionKey } from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { apiError } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
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
  const target = (c: Context<AppEnv>, schema: string | undefined) => {
    const db = c.req.param('db') ?? ''
    return { ns: schema ? { database: db, schema } : { database: db }, table: c.req.param('table') ?? '' }
  }
  const path = '/databases/:db/tables/:table/tracking'
  return (
    new Hono<AppEnv>()
      .use(path, requireSession(cfg))
      .get(path, validate('query', SchemaQuerySchema), async (c) => {
        const { ns, table } = target(c, c.req.valid('query').schema)
        const current = await definition(c, ns, table)
        return c.json<TrackingState>({ versions: await versions(c, ns, table), current })
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
        if (latest?.definition === current) return c.json<TrackingState>({ versions: known, current })
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
        logger.log('info', 'tracking.record', {
          requestId: c.get('requestId'),
          ...sessionInfo(session),
          database: ns.database,
          table,
          version: body.version,
        })
        return c.json<TrackingState>({ versions: await versions(c, ns, table), current })
      })
      // Stops tracking: every version of this table goes.
      .delete(path, validate('query', SchemaQuerySchema), async (c) => {
        const store = cfg.store.sharedItems
        if (!store) return unsupported(c)
        const session = c.get('session')
        const { ns, table } = target(c, c.req.valid('query').schema)
        const current = await definition(c, ns, table)
        for (const v of await versions(c, ns, table)) await store.remove(session.config, 'tracking', v.id)
        logger.log('info', 'tracking.stop', {
          requestId: c.get('requestId'),
          ...sessionInfo(session),
          database: ns.database,
          table,
        })
        return c.json<TrackingState>({ versions: [], current })
      })
  )
}
