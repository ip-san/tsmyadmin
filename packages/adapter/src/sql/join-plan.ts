/** The JOIN clauses of the query builder: explicit joins first, then foreign keys. */
import type { Dialect, Namespace, QueryBuilderJoin, QueryJoinStep, TableSchema } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/**
 * LEFT JOINs that bring every table after the first into the query, each along a foreign key to a table already
 * joined (either direction). Keys into another database or schema do not count. A table no key reaches is
 * refused rather than cross-joined: a product of two tables is almost never what was meant, and the SQL tab is
 * there for queries that need it.
 */
export function joinPlan(
  d: Dialect,
  ns: Namespace,
  tables: string[],
  schemas: Map<string, TableSchema>,
  explicit: readonly QueryBuilderJoin[] = []
): string[] {
  return joinSql(d, ns, joinSteps(d, ns, tables, schemas, explicit))
}

/** The JOIN clauses of the steps, in their order. */
export function joinSql(d: Dialect, ns: Namespace, steps: readonly QueryJoinStep[]): string[] {
  const col = (r: { table: string; column: string }) => `${quoteIdent(d, r.table)}.${quoteIdent(d, r.column)}`
  return steps.map((step) => {
    const on = step.on.map((p) => `${col(p.a)} = ${col(p.b)}`).join(' AND ')
    return `${step.kind.toUpperCase()} JOIN ${quoteTable(d, ns, step.table)} ON ${on}`
  })
}

/**
 * How each table after the first is joined, in order: the joins spelled out, then each along a foreign key (`key`
 * names it, and the table it is defined on). What `joinPlan` writes, as data: the query tab tells it scene by scene.
 */
export function joinSteps(
  d: Dialect,
  ns: Namespace,
  tables: string[],
  schemas: Map<string, TableSchema>,
  explicit: readonly QueryBuilderJoin[] = []
): QueryJoinStep[] {
  const home = (other: Namespace) =>
    other.database === ns.database && (d === 'mysql' || (other.schema ?? 'public') === (ns.schema ?? 'public'))
  // Every table is described, so their own foreign keys already hold every link between them.
  const links = tables.flatMap((from) =>
    (schemas.get(from)?.foreignKeys ?? [])
      .filter((fk) => home(fk.refNamespace) && fk.refTable !== from)
      .map((fk) => ({ from, to: fk.refTable, fk }))
  )
  const joined = new Set(tables.slice(0, 1))
  const out: QueryJoinStep[] = []
  // Joins spelled out come first, in the order of the tables; each may use only tables already joined.
  const has = (r: { table: string; column: string }) =>
    schemas.get(r.table)?.columns.some((c) => c.name === r.column) === true
  for (const table of tables.slice(1)) {
    const j = explicit.find((x) => x.table === table)
    if (!j) continue
    for (const p of j.on) {
      if (!has(p.from) || !has(p.to)) throw new AdapterError('NOT_FOUND', `Unknown column in the join of ${table}`)
      const other = p.from.table === table ? p.to.table : p.from.table
      if (!(p.from.table === table || p.to.table === table) || !(joined.has(other) || other === table))
        throw new AdapterError('VALIDATION', `The join of ${table} must use ${table} and a table joined before it`)
    }
    out.push({ table, kind: j.kind, on: j.on.map((p) => ({ a: p.from, b: p.to })), key: null })
    joined.add(table)
  }
  // Repeated passes in the order given, so a table reachable only through a later one still joins, and the same
  // request always gives the same SQL.
  for (let progress = true; progress; ) {
    progress = false
    for (const table of tables) {
      if (joined.has(table)) continue
      const link = links.find((l) => (l.from === table && joined.has(l.to)) || (l.to === table && joined.has(l.from)))
      if (!link) continue
      out.push({
        table,
        kind: 'left',
        on: link.fk.columns.map((c, i) => ({
          a: { table: link.to, column: link.fk.refColumns[i] ?? '' },
          b: { table: link.from, column: c },
        })),
        key: { table: link.from, name: link.fk.name },
      })
      joined.add(table)
      progress = true
    }
  }
  const unreached = tables.filter((t) => !joined.has(t))
  if (unreached.length > 0)
    throw new AdapterError('VALIDATION', `No foreign key connects ${unreached.join(', ')} to ${tables[0]}`)
  return out
}
