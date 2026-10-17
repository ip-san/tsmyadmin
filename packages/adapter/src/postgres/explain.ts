/** `EXPLAIN (FORMAT JSON)` of PostgreSQL, read into the plan tree both servers share. */
import type { PlanAccess, PlanNode } from '@tsmyadmin/shared'

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The first condition a node carries, in the order that says most about how it reads. */
const CONDITIONS = ['Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter']

function access(n: Json): PlanAccess | null {
  switch (n['Node Type']) {
    case 'Seq Scan':
    case 'Parallel Seq Scan':
      return 'fullScan'
    case 'Index Scan':
    case 'Index Only Scan':
      // No condition: the index is read end to end, for its order.
      return n['Index Cond'] === undefined ? 'fullIndexScan' : 'range'
    case 'Bitmap Heap Scan':
    case 'Bitmap Index Scan':
      return 'range'
    default:
      return null
  }
}

/** The index a bitmap scan of the table reads, from the Bitmap Index Scan under it. */
function bitmapIndex(n: Json): string | null {
  for (const child of Array.isArray(n.Plans) ? n.Plans.filter(isObject) : []) {
    const found = str(child['Index Name']) ?? bitmapIndex(child)
    if (found) return found
  }
  return null
}

function toNode(n: Json): PlanNode {
  const type = str(n['Node Type']) ?? 'Step'
  const table = str(n['Relation Name'])
  const alias = str(n.Alias)
  const op = [
    type === 'ModifyTable' ? (str(n.Operation) ?? type) : type,
    // An inner join is the one meant when none is named; a semi or anti join changes what the step gives.
    str(n['Join Type']) && n['Join Type'] !== 'Inner' ? `(${n['Join Type']})` : null,
    str(n['Subplan Name']),
  ]
    .filter(Boolean)
    .join(' ')
  return {
    op,
    table,
    alias: alias && alias !== table ? alias : null,
    index: str(n['Index Name']) ?? (type === 'Bitmap Heap Scan' ? bitmapIndex(n) : null),
    indexColumns: [],
    access: type === 'ModifyTable' ? null : access(n),
    covering: type === 'Index Only Scan',
    estRows: num(n['Plan Rows']),
    cost: num(n['Total Cost']),
    detail: CONDITIONS.map((k) => str(n[k])).find(Boolean) ?? null,
    children: Array.isArray(n.Plans) ? n.Plans.filter(isObject).map(toNode) : [],
  }
}

export function parsePgPlan(raw: unknown): PlanNode {
  const first = Array.isArray(raw) ? raw[0] : raw
  const plan = isObject(first) && isObject(first.Plan) ? first.Plan : {}
  return toNode(plan)
}
