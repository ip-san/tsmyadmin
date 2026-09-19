import type { ConnectRequest, HistoryEntry, SharedQuery, SqlHistory } from '@tsmyadmin/shared'
import {
  AddHistoryRequestSchema,
  HistoryEntrySchema,
  SavedQueryIdSchema,
  SaveQueryRequestSchema,
} from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { apiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'
import type { SavedItem, SavedItems } from '../session/store.ts'

const SharedBodySchema = z.object({ sql: z.string().min(1), by: z.string() })
const HISTORY = 'history'

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function readHistory(store: SavedItems, config: ConnectRequest): Promise<HistoryEntry[]> {
  const item = (await store.list(config, HISTORY))[0]
  const body = z.object({ entries: z.array(HistoryEntrySchema) }).safeParse(safeJson(item?.body ?? ''))
  return body.success ? body.data.entries : []
}

function shared(items: SavedItem[]): SharedQuery[] {
  return items.flatMap((item) => {
    const body = SharedBodySchema.safeParse(safeJson(item.body))
    return body.success ? [{ id: item.id, name: item.name, sql: body.data.sql, by: body.data.by, at: item.at }] : []
  })
}

/**
 * What the SQL console keeps with the account: statements bookmarked for every account of the server (a bookmark is
 * removed only by the account that saved it), and the history of runs. Both need the persistent session store.
 */
export function sqlListRoutes(cfg: SessionConfig) {
  const unsupported = (c: Context) =>
    c.json(apiError('UNSUPPORTED', 'Shared queries and history need a persistent session store'), 400)
  return new Hono<AppEnv>()
    .use('/shared-queries', requireSession(cfg))
    .use('/shared-queries/*', requireSession(cfg))
    .use('/sql-history', requireSession(cfg))
    .get('/shared-queries', async (c) =>
      c.json(shared((await cfg.store.sharedItems?.list(c.get('session').config, 'sharedsql')) ?? []))
    )
    .post('/shared-queries', validate('json', SaveQueryRequestSchema), async (c) => {
      const store = cfg.store.sharedItems
      if (!store) return unsupported(c)
      const config = c.get('session').config
      const { name, sql } = c.req.valid('json')
      // A name is one statement for the whole server: saving over another account's would replace theirs.
      const taken = shared(await store.list(config, 'sharedsql')).find((q) => q.name === name)
      if (taken && taken.by !== config.user)
        return c.json(apiError('CONFLICT', `A shared query named ${name} belongs to another account`), 409)
      return c.json(shared(await store.save(config, 'sharedsql', name, JSON.stringify({ sql, by: config.user }))))
    })
    .delete('/shared-queries/:id', validate('param', SavedQueryIdSchema), async (c) => {
      const store = cfg.store.sharedItems
      if (!store) return unsupported(c)
      const config = c.get('session').config
      const id = c.req.valid('param').id
      const target = shared(await store.list(config, 'sharedsql')).find((q) => q.id === id)
      if (target && target.by !== config.user)
        return c.json(apiError('FORBIDDEN', 'Only the account that saved a shared query can remove it'), 403)
      return c.json(shared(await store.remove(config, 'sharedsql', id)))
    })
    .get('/sql-history', async (c) => {
      const store = cfg.store.savedQueries
      return c.json<SqlHistory>({ entries: store ? await readHistory(store, c.get('session').config) : [] })
    })
    .post('/sql-history', validate('json', AddHistoryRequestSchema), async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      const config = c.get('session').config
      const { entry, limit } = c.req.valid('json')
      const kept = [entry, ...(await readHistory(store, config)).filter((e) => e.sql !== entry.sql)].slice(0, limit)
      await store.save(config, HISTORY, HISTORY, JSON.stringify({ entries: kept }))
      return c.json<SqlHistory>({ entries: kept })
    })
    .delete('/sql-history', async (c) => {
      const store = cfg.store.savedQueries
      if (!store) return unsupported(c)
      await store.save(c.get('session').config, HISTORY, HISTORY, JSON.stringify({ entries: [] }))
      return c.json<SqlHistory>({ entries: [] })
    })
}
