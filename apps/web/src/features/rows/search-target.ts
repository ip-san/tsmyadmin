import type { Filter, QueryBuilderRequestInput } from '@tsmyadmin/shared'
import { encodeSort } from '@tsmyadmin/shared'
import type { SearchOptionsValue } from './SearchOptions.tsx'

/** The browse tab's search params for a search it can show itself: filters, columns, order and page size. */
export function browseParams(filters: Filter[], o: SearchOptionsValue, all: string[]) {
  return {
    ...(filters.length > 0 ? { filters: JSON.stringify(filters) } : {}),
    // The browse tab's `cols`: omitted when every column is shown.
    ...(o.columns.length < all.length ? { cols: o.columns.join(',') } : {}),
    ...(o.sort ? { sort: encodeSort([o.sort]) } : {}),
    ...(o.limit !== null ? { limit: o.limit } : {}),
    page: 1,
  }
}

/** A SELECT for the SQL tab, for a search the browse tab cannot show (DISTINCT, conditions typed as SQL). */
export function statementRequest(
  table: string,
  schema: string | undefined,
  filters: Filter[],
  o: SearchOptionsValue,
  all: string[]
): QueryBuilderRequestInput {
  const shown = o.columns.length === all.length && !o.sort ? [] : o.columns
  const columns: NonNullable<QueryBuilderRequestInput['columns']> = shown.map((column) => ({
    table,
    column,
    sort: o.sort?.column === column ? o.sort.direction : null,
  }))
  // Sorting by a column that is not shown: listed only for its ORDER BY.
  if (o.sort && !shown.includes(o.sort.column))
    columns.push({ table, column: o.sort.column, sort: o.sort.direction, show: false })
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const where = filters.map((f) => ({
    table,
    column: f.column,
    op: f.op,
    ...(f.value !== undefined ? { value: text(f.value) } : {}),
    ...(f.values ? { values: f.values.map(text) } : {}),
  }))
  return {
    ...(schema ? { schema } : {}),
    tables: [table],
    columns,
    where: where.length > 0 ? [where] : [],
    distinct: o.distinct,
    whereSql: o.whereSql.trim(),
    limit: o.limit,
  }
}
