import type { IndexDef, TableSchema } from '@tsmyadmin/shared'

/**
 * Whether an index (the primary key among them) starts with the key's columns, in any order: an index on
 * (a, b, c) serves a key on (b, a), not one on (b) or (a, c). A partial index (some rows only) and a full-text or
 * spatial one (not of the values) do not serve a join. A key of no columns (as a catalog may report) needs none.
 */
export function indexed(schema: Pick<TableSchema, 'primaryKey' | 'indexes'>, columns: readonly string[]): boolean {
  const wanted = new Set(columns)
  const starts = (cols: readonly string[]) =>
    cols.length >= wanted.size && cols.slice(0, wanted.size).every((c) => wanted.has(c))
  const serves = (i: IndexDef) => i.predicate === null && !/^(fulltext|spatial)$/i.test(i.type ?? '')
  return starts(schema.primaryKey) || schema.indexes.some((i) => serves(i) && starts(i.columns))
}
