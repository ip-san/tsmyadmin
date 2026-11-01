/**
 * Plans with indexes that are not built, through the HypoPG extension: the planner sees them, nothing is written.
 * HypoPG keeps them in the server process, outside any transaction: a ROLLBACK and a DISCARD ALL leave them, so they
 * are cleared after every plan, and a connection that cannot clear them is not reused.
 */
import type { ExplainResult, HypotheticalIndex, Namespace, PlanNode } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { AdapterError } from '../types.ts'
import { createIndexSql } from './ddl-common.ts'
import { explainResult, parseJsonCell } from './explain-statement.ts'
import { quoteIdent } from './quote.ts'

/** The schema HypoPG is installed in, in the connection's database; null where it is not. */
export async function hypopgSchema(conn: Conn): Promise<string | null> {
  const r = firstResult(
    await conn.query(
      "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'hypopg'"
    )
  )
  const name = r.rows[0]?.[0]
  return typeof name === 'string' ? name : null
}

/** The server's names for the indexes assumed (`<13630>btree_t_a`) put back to the names given, all through the plan. */
function renamed(raw: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(raw)) return raw.map((v) => renamed(v, names))
  if (typeof raw !== 'object' || raw === null) return raw
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k,
      k === 'Index Name' && typeof v === 'string' ? (names.get(v) ?? v) : renamed(v, names),
    ])
  )
}

/** The indexes of a plan read through, of those named. */
function readThrough(node: PlanNode, names: ReadonlySet<string>, out = new Set<string>()): Set<string> {
  if (node.index !== null && names.has(node.index)) out.add(node.index)
  for (const c of node.children) readThrough(c, names, out)
  return out
}

/**
 * The estimated plan of `statement` (already checked to be one EXPLAIN takes) with `indexes` assumed: each made with
 * `hypopg_create_index` from the CREATE INDEX the DDL preview would show (passed as a value), in a read-only
 * transaction rolled back, then all cleared with `hypopg_reset`.
 */
export async function pgHypotheticalPlan(
  conn: Conn,
  ns: Namespace,
  statement: string,
  indexes: readonly HypotheticalIndex[],
  /** PostgreSQL's plan JSON read into the shared tree. */
  parse: (raw: unknown) => PlanNode
): Promise<ExplainResult> {
  const schema = await hypopgSchema(conn)
  if (schema === null) throw new AdapterError('UNSUPPORTED', 'The HypoPG extension is not installed in this database')
  const fn = (name: string) => `${quoteIdent('postgres', schema)}.${name}`
  await conn.query('BEGIN READ ONLY')
  try {
    const names = new Map<string, string>()
    for (const i of indexes) {
      const ddl = createIndexSql('postgres', ns, { table: i.table, name: i.name, columns: i.columns, unique: false })
      const made = firstResult(await conn.query(`SELECT indexname FROM ${fn('hypopg_create_index')}($1)`, [ddl])).rows
      const server = made[0]?.[0]
      if (typeof server === 'string') names.set(server, i.name)
    }
    const raw = renamed(
      parseJsonCell(firstResult(await conn.query(`EXPLAIN (FORMAT JSON) ${statement}`)).rows[0]?.[0] ?? null),
      names
    )
    const plan = parse(raw)
    return { ...explainResult(plan, raw), assumed: [...readThrough(plan, new Set(names.values()))] }
  } finally {
    // The transaction first: a failed statement leaves it aborted, and nothing else runs in it.
    await conn.query('ROLLBACK').catch(() => undefined)
    await conn.query(`SELECT ${fn('hypopg_reset')}()`).catch(() => conn.discard())
  }
}
