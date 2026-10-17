/** What a delete would reach through ON DELETE, counted without deleting anything. */
import {
  DELETE_IMPACT_MAX_DEPTH,
  type DeleteImpact,
  type DeleteImpactStep,
  type Dialect,
  deleteActionOf,
  type Namespace,
  type RelationDef,
  type RowKey,
} from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { buildKeyWhere, type ConditionHooks } from './conditions.ts'
import { Params, quoteIdent, quoteTable } from './quote.ts'

/** Keys followed at most, across every depth: a schema of many paths between the same tables would otherwise grow without end. */
export const DELETE_IMPACT_MAX_STEPS = 200

/** What deleting the rows `keys` name would reach, counted on `conn`. `types` are the key columns' types, for casts. */
export function deleteImpactOn(
  conn: Conn,
  o: {
    hooks: ConditionHooks
    ns: Namespace
    table: string
    keys: readonly RowKey[]
    types: Map<string, string>
    relations: readonly RelationDef[]
  }
): Promise<DeleteImpact> {
  // One condition for every key, with the values bound once: each count repeats it, so each binds them all.
  const params = new Params(o.hooks.dialect)
  const where = o.keys
    .map((key) => `(${buildKeyWhere(o.hooks, key, params, o.types).replace(/^ WHERE /, '')})`)
    .join(' OR ')
  return walkDeleteImpact({
    dialect: o.hooks.dialect,
    ns: o.ns,
    table: o.table,
    relations: o.relations,
    where,
    count: async (sql) => Number(firstResult(await conn.query(sql, params.values)).rows[0]?.[0] ?? 0),
  })
}

/**
 * Follows the keys that refer to `table`, depth by depth, from the rows `where` picks. Each count is one SELECT whose
 * condition nests the condition of the rows above it (`child.fk IN (SELECT parent.key FROM parent WHERE …)`), so
 * every query carries the starting condition once and `count` binds the same values to each.
 *
 * Only CASCADE goes deeper: SET NULL and SET DEFAULT change the rows that refer but delete none, and RESTRICT and
 * NO ACTION with rows referring make the delete fail (`blocked`). A key with no rows referring ends its path, which
 * is also what ends a walk round a self-referencing table. Keys into this namespace from another are not seen.
 */
export async function walkDeleteImpact(o: {
  dialect: Dialect
  ns: Namespace
  table: string
  relations: readonly RelationDef[]
  /** The rows to delete, as a condition on `table` (no `WHERE`). */
  where: string
  count: (sql: string) => Promise<number>
}): Promise<DeleteImpact> {
  const d = o.dialect
  const home = (other: Namespace) =>
    other.database === o.ns.database && (d === 'mysql' || (other.schema ?? 'public') === (o.ns.schema ?? 'public'))
  const from = (table: string) => quoteTable(d, o.ns, table)
  const rows = await o.count(`SELECT COUNT(*) FROM ${from(o.table)} WHERE ${o.where}`)
  const steps: DeleteImpactStep[] = []
  let blocked = false
  let capped = false
  let level = rows > 0 ? [{ table: o.table, where: o.where }] : []
  for (let depth = 1; level.length > 0; depth++) {
    const next: typeof level = []
    for (const parent of level) {
      for (const fk of o.relations.filter((r) => r.refTable === parent.table && home(r.refNamespace))) {
        if (depth > DELETE_IMPACT_MAX_DEPTH || steps.length >= DELETE_IMPACT_MAX_STEPS) {
          capped = true
          continue
        }
        const where = referring(
          d,
          fk,
          `SELECT ${fk.refColumns.map((c) => quoteIdent(d, c)).join(', ')} FROM ${from(parent.table)} WHERE ${parent.where}`
        )
        const n = await o.count(`SELECT COUNT(*) FROM ${from(fk.table)} WHERE ${where}`)
        const action = deleteActionOf(fk.onDelete)
        steps.push({
          depth,
          table: fk.table,
          constraint: fk.name,
          columns: fk.columns,
          refTable: parent.table,
          action,
          rows: n,
        })
        if (n === 0) continue
        if (action === 'cascade') next.push({ table: fk.table, where })
        if (action === 'restrict' || action === 'noAction') blocked = true
      }
    }
    level = next
  }
  return { table: o.table, rows, steps, blocked, capped }
}

/**
 * The rows of a key's table that refer to the rows `parents` selects. A row with a NULL in the key refers to nothing
 * (MATCH SIMPLE), which `IN` already gives: a comparison with NULL is never true.
 */
function referring(d: Dialect, fk: RelationDef, parents: string): string {
  const cols = fk.columns.map((c) => quoteIdent(d, c))
  const left = cols.length === 1 ? (cols[0] ?? '') : `(${cols.join(', ')})`
  return `${left} IN (${parents})`
}
