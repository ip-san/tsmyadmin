import type { CentralColumn, ColumnTransform, Preferences } from '@tsmyadmin/shared'
import {
  CentralColumnBodySchema,
  ColumnTransformBodySchema,
  centralColumnKey,
  columnTransformKey,
  PreferencesSchema,
  SavedQueryIdSchema,
} from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import type { z } from 'zod'
import { apiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'
import type { SavedItem, SavedItemKind } from '../session/store.ts'

/** The one row a preferences item is stored under. */
const PREFERENCES = 'preferences'

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Stored rows of one kind as the client sees them. A body that does not parse is left out and left alone: a newer
 * version may have written it, and deleting what this one cannot read would turn a downgrade into data loss.
 */
function parsed<T>(items: SavedItem[], schema: z.ZodType<T>): (T & { id: string; at: number })[] {
  return items.flatMap((item) => {
    const body = schema.safeParse(safeJson(item.body))
    return body.success ? [{ ...body.data, id: item.id, at: item.at }] : []
  })
}

const unsupported = (c: Context) =>
  c.json(apiError('UNSUPPORTED', 'Keeping this with the account needs a persistent session store'), 400)

/**
 * What an account keeps besides bookmarks and export templates: its preferences, central columns and column
 * transformations. Like those, they exist only where the session store is persistent; elsewhere the browser
 * keeps them, and these routes answer an empty list (reads) or UNSUPPORTED (writes).
 */
export function storedRoutes(cfg: SessionConfig) {
  const list = async (c: Context<AppEnv>, kind: SavedItemKind) =>
    (await cfg.store.savedQueries?.list(c.get('session').config, kind)) ?? []
  const central = (items: SavedItem[]): CentralColumn[] => parsed(items, CentralColumnBodySchema)
  const transforms = (items: SavedItem[]): ColumnTransform[] => parsed(items, ColumnTransformBodySchema)
  return new Hono<AppEnv>()
    .use('/preferences', requireSession(cfg))
    .use('/central-columns/*', requireSession(cfg))
    .use('/central-columns', requireSession(cfg))
    .use('/column-transforms/*', requireSession(cfg))
    .use('/column-transforms', requireSession(cfg))
    .get('/preferences', async (c) => {
      const row = (await list(c, 'prefs')).find((item) => item.name === PREFERENCES)
      const prefs = PreferencesSchema.safeParse(row ? safeJson(row.body) : {})
      return c.json<Preferences>(prefs.success ? prefs.data : {})
    })
    .put('/preferences', validate('json', PreferencesSchema), async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      // Merged into what is stored rather than replacing it: two tabs each send only what they know, and the
      // theme set in one must survive the console toggled in the other.
      const row = (await list(c, 'prefs')).find((item) => item.name === PREFERENCES)
      const stored = PreferencesSchema.safeParse(row ? safeJson(row.body) : {})
      const prefs = { ...(stored.success ? stored.data : {}), ...c.req.valid('json') }
      await store.save(c.get('session').config, 'prefs', PREFERENCES, JSON.stringify(prefs))
      return c.json<Preferences>(prefs)
    })
    .get('/central-columns', async (c) => c.json(central(await list(c, 'central'))))
    .post('/central-columns', validate('json', CentralColumnBodySchema), async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      const column = c.req.valid('json')
      // Keyed by database + name: the store replaces by name, and every database has its own list.
      const key = centralColumnKey(column)
      return c.json(central(await store.save(c.get('session').config, 'central', key, JSON.stringify(column))))
    })
    .delete('/central-columns/:id', validate('param', SavedQueryIdSchema), async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      return c.json(central(await store.remove(c.get('session').config, 'central', c.req.valid('param').id)))
    })
    .get('/column-transforms', async (c) => c.json(transforms(await list(c, 'transform'))))
    .post('/column-transforms', validate('json', ColumnTransformBodySchema), async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      const transform = c.req.valid('json')
      // One per column: setting another replaces it.
      const key = columnTransformKey(transform)
      return c.json(transforms(await store.save(c.get('session').config, 'transform', key, JSON.stringify(transform))))
    })
    .delete('/column-transforms/:id', validate('param', SavedQueryIdSchema), async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      return c.json(transforms(await store.remove(c.get('session').config, 'transform', c.req.valid('param').id)))
    })
}
