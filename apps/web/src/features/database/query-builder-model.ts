import type { QueryBuilderOp, QueryBuilderRequestInput } from '@tsmyadmin/shared'
import { conditionText, conditionValue } from '@/lib/filter-values.ts'

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

/** How one table joins: along a foreign key (kind ''), or of a kind on one pair of columns. */
export interface JoinRow {
  kind: '' | 'inner' | 'left' | 'right'
  /** A column of this table. */
  from: ColumnKey
  /** A column of a table before it. */
  to: ColumnKey
}

/** The joins spelled out, for the tables still chosen; a row missing a column falls back to the foreign key. */
export function toJoins(tables: readonly string[], joins: Readonly<Record<string, JoinRow>>) {
  return tables.slice(1).flatMap((table) => {
    const j = joins[table]
    const from = j ? parseKey(j.from) : null
    const to = j ? parseKey(j.to) : null
    if (!j || j.kind === '' || !from || !to || !tables.includes(to.table)) return []
    return [{ table, kind: j.kind, on: [{ from, to }] }]
  })
}

/** The request for the rows as they stand. Rows with no column chosen, or of a table no longer chosen, are left out. */
export function toRequest(
  tables: readonly string[],
  outputs: readonly OutputRow[],
  groups: readonly ConditionGroup[],
  schema: string | undefined,
  joins: Readonly<Record<string, JoinRow>> = {}
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
  const spelled = toJoins(tables, joins)
  return {
    ...(schema ? { schema } : {}),
    tables: [...tables],
    columns,
    where,
    ...(spelled.length > 0 ? { joins: spelled } : {}),
  }
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

/** A saved request back as the form's rows (new ids), so a saved setup can be edited like one built by hand. */
export function fromRequest(
  request: Pick<QueryBuilderRequestInput, 'tables' | 'columns' | 'where' | 'joins'>,
  newId: () => number
): { tables: string[]; outputs: OutputRow[]; groups: ConditionGroup[]; joins: Record<string, JoinRow> } {
  const outputs = (request.columns ?? []).map((c) => ({
    id: newId(),
    key: columnKey(c.table, c.column),
    alias: c.alias ?? '',
    show: c.show ?? true,
    sort: c.sort ?? ('' as const),
  }))
  const groups = (request.where ?? []).map((g) => ({
    id: newId(),
    conditions: g.map((c) => ({
      id: newId(),
      key: columnKey(c.table, c.column),
      op: c.op,
      value: conditionText(c),
    })),
  }))
  const joins: Record<string, JoinRow> = {}
  for (const j of request.joins ?? []) {
    const on = j.on[0]
    if (on)
      joins[j.table] = {
        kind: j.kind ?? 'inner',
        from: columnKey(on.from.table, on.from.column),
        to: columnKey(on.to.table, on.to.column),
      }
  }
  return { tables: [...request.tables], outputs, groups, joins }
}
