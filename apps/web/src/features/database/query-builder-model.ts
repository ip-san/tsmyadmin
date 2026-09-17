import type { QueryBuilderOp, QueryBuilderRequestInput } from '@tsmyadmin/shared'

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

export const NO_VALUE: ReadonlySet<QueryBuilderOp> = new Set(['is_null', 'is_not_null'])

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
        return [NO_VALUE.has(c.op) ? { ...r, op: c.op } : { ...r, op: c.op, value: c.value }]
      })
    )
    .filter((g) => g.length > 0)
  return { ...(schema ? { schema } : {}), tables: [...tables], columns, where }
}
