import { randomUUID } from 'node:crypto'
import type { ConnectRequest } from '@tsmyadmin/shared'
import {
  classifyStatement,
  type Dialect,
  type Namespace,
  TRACKED_STATEMENT_MAX,
  type TrackedStatement,
  type TrackKind,
  TrackKindSchema,
} from '@tsmyadmin/shared'
import { z } from 'zod'
import type { SavedItems } from '../session/store.ts'
import type { Logger } from './logging.ts'

/** A tracked table's settings, one stored item per table. */
const ConfBodySchema = z.object({
  database: z.string(),
  schema: z.string().optional(),
  table: z.string(),
  kinds: z.array(TrackKindSchema),
})

/** One recorded statement as stored (the id and time come from the store). */
const LogBodySchema = z.object({
  database: z.string(),
  schema: z.string().optional(),
  table: z.string(),
  kind: TrackKindSchema,
  statement: z.string().nullable(),
  truncated: z.boolean().default(false),
  rows: z.number().int().min(0).optional(),
  columns: z.array(z.string()).optional(),
  by: z.string(),
})

const parse = <T>(schema: z.ZodType<T>, text: string): T | null => {
  try {
    const r = schema.safeParse(JSON.parse(text))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

const inNs = (b: { database: string; schema?: string | undefined }, ns: Namespace) =>
  b.database === ns.database && (b.schema ?? '') === (ns.schema ?? '')

const trackConfKey = (ns: Namespace, table: string) => JSON.stringify([ns.database, ns.schema ?? '', table])

/** Every tracked table of a namespace with the kinds it records. */
export async function trackedKinds(store: SavedItems, config: ConnectRequest, ns: Namespace) {
  const out = new Map<string, { id: string; kinds: TrackKind[] }>()
  for (const item of await store.list(config, 'trackconf')) {
    const body = parse(ConfBodySchema, item.body)
    if (body && inNs(body, ns)) out.set(body.table, { id: item.id, kinds: body.kinds })
  }
  return out
}

export async function setTrackedKinds(
  store: SavedItems,
  config: ConnectRequest,
  ns: Namespace,
  table: string,
  kinds: TrackKind[]
) {
  const body = { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}), table, kinds }
  await store.save(config, 'trackconf', trackConfKey(ns, table), JSON.stringify(body))
}

/** The statements recorded for one table, newest first. */
export async function trackedStatements(
  store: SavedItems,
  config: ConnectRequest,
  ns: Namespace,
  table: string
): Promise<(TrackedStatement & { storeId: string })[]> {
  const out: (TrackedStatement & { storeId: string })[] = []
  for (const item of await store.list(config, 'tracklog')) {
    const body = parse(LogBodySchema, item.body)
    if (!body || !inNs(body, ns) || body.table !== table) continue
    const { database: _d, schema: _s, table: _t, ...entry } = body
    out.push({ ...entry, id: item.id, at: item.at, storeId: item.id })
  }
  return out.sort((a, b) => b.at - a.at)
}

type Entry = Omit<z.infer<typeof LogBodySchema>, 'database' | 'schema' | 'by'>

async function append(store: SavedItems, config: ConnectRequest, ns: Namespace, entry: Entry) {
  const body = { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}), ...entry, by: config.user }
  await store.save(config, 'tracklog', `${Date.now()}-${randomUUID()}`, JSON.stringify(body))
}

/**
 * Records the statements that ran against tracked tables, in the kinds each table records. A statement naming
 * another database / schema than the one it ran in is matched against that one. Failing to record never fails the
 * statement: it already ran; the failure is logged (event and identifiers only).
 */
export async function recordStatements(
  store: SavedItems | undefined,
  config: ConnectRequest,
  ns: Namespace,
  statements: readonly string[],
  dialect: Dialect,
  logger?: Logger
): Promise<void> {
  if (!store || statements.length === 0) return
  try {
    const found = statements.flatMap((sql) => {
      const c = classifyStatement(sql)
      return c ? [{ sql, ...c }] : []
    })
    if (found.length === 0) return
    const confs = new Map<string, Awaited<ReturnType<typeof trackedKinds>>>()
    for (const f of found) {
      // A qualifier is a database on MySQL, a schema of this database on PostgreSQL.
      const target: Namespace = f.qualifier
        ? dialect === 'postgres'
          ? { database: ns.database, schema: f.qualifier }
          : { database: f.qualifier }
        : ns
      const key = JSON.stringify([target.database, target.schema ?? ''])
      if (!confs.has(key)) confs.set(key, await trackedKinds(store, config, target))
      if (!confs.get(key)?.get(f.table)?.kinds.includes(f.kind)) continue
      const cut = f.sql.length > TRACKED_STATEMENT_MAX
      await append(store, config, target, {
        table: f.table,
        kind: f.kind,
        statement: cut ? f.sql.slice(0, TRACKED_STATEMENT_MAX) : f.sql,
        truncated: cut,
      })
    }
  } catch {
    logger?.log('warn', 'tracking.log_failed', { database: ns.database })
  }
}

/** A row changed in the grid: what was done, never the values. */
export async function recordGridChange(
  store: SavedItems | undefined,
  config: ConnectRequest,
  ns: Namespace,
  table: string,
  kind: 'insert' | 'update' | 'delete',
  rows: number,
  columns: string[],
  logger?: Logger
): Promise<void> {
  if (!store) return
  try {
    if (!(await trackedKinds(store, config, ns)).get(table)?.kinds.includes(kind)) return
    await append(store, config, ns, { table, kind, statement: null, truncated: false, rows, columns })
  } catch {
    logger?.log('warn', 'tracking.log_failed', { database: ns.database, table })
  }
}
