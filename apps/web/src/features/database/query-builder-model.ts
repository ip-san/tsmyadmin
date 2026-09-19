import type { QueryBuilderOp, QueryBuilderRequestInput } from '@tsmyadmin/shared'
import { conditionValue } from '@/lib/filter-values.ts'

type SortDirection = 'asc' | 'desc'

/** A column of one of the chosen tables, as a select's value: JSON keeps any character in either name apart. */
export type ColumnKey = string
export const columnKey = (table: string, column: string): ColumnKey => JSON.stringify([table, column])

function parseKey(key: ColumnKey): { table: string; column: string } | null {
  if (key === '') return null
  const [table, column] = JSON.parse(key) as [string, string]
  return { table, column }
}

export interface OutputRow {
  id: number
  key: ColumnKey
  alias: string
  show: boolean
  sort: SortDirection | ''
}

export interface ConditionRow {
  id: number
  key: ColumnKey
  op: QueryBuilderOp
  value: string
}

/** AND of its conditions; groups are OR-ed. */
export interface ConditionGroup {
  id: number
  conditions: ConditionRow[]
}

/** The request for the rows as they stand. Rows with no column chosen, or of a table no longer chosen, are left out. */
export function toRequest(
  tables: readonly string[],
  outputs: readonly OutputRow[],
  groups: readonly ConditionGroup[],
  schema: string | undefined
): QueryBuilderRequestInput {
  const ref = (key: ColumnKey) => {
    const r = parseKey(key)
    return r && tables.includes(r.table) ? r : null
  }
  const columns = outputs.flatMap((o) => {
    const r = ref(o.key)
    return r ? [{ ...r, alias: o.alias.trim(), show: o.show, sort: o.sort === '' ? null : o.sort }] : []
  })
  const where = groups
    .map((g) =>
      g.conditions.flatMap((c) => {
        const r = ref(c.key)
        if (!r) return []
        return [{ ...r, op: c.op, ...conditionValue(c.op, c.value) }]
      })
    )
    .filter((g) => g.length > 0)
  return { ...(schema ? { schema } : {}), tables: [...tables], columns, where }
}

/** Rows of `table` removed when it is unticked, so none is left on screen pointing at a column no longer offered. */
export function withoutTable(
  table: string,
  outputs: readonly OutputRow[],
  groups: readonly ConditionGroup[]
): { outputs: OutputRow[]; groups: ConditionGroup[] } {
  const keep = (key: ColumnKey) => parseKey(key)?.table !== table
  return {
    outputs: outputs.filter((o) => keep(o.key)),
    groups: groups
      .map((g) => ({ ...g, conditions: g.conditions.filter((c) => keep(c.key)) }))
      .filter((g) => g.conditions.length > 0),
  }
}
