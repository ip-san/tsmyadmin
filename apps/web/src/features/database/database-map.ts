import type { IndexDef, Namespace, TableSchema } from '@tsmyadmin/shared'
import { type TableRole, tableRole } from '@/lib/table-role.ts'

/** Tables named as the most referred to: the ones a newcomer reads first. */
const HUBS_SHOWN = 10

/** A foreign key no index starts with: a join or a delete on the parent reads the whole child table. */
interface UnindexedKey {
  table: string
  key: string
  columns: readonly string[]
  refTable: string
}

export interface DatabaseMap {
  tables: number
  views: number
  /** The tables of each role (views have no keys to guess from), by name. */
  roles: Record<TableRole, string[]>
  /** The tables most referred to (by how many other tables), the most first. */
  hubs: { table: string; referredBy: number }[]
  noPrimaryKey: string[]
  unindexedKeys: UnindexedKey[]
}

/** The roles in the order they are read: what the rest hangs from first, what joins to nothing last. */
export const ROLE_ORDER: readonly TableRole[] = ['master', 'middle', 'detail', 'junction', 'tree', 'isolated']

/**
 * Whether an index (the primary key among them) starts with the key's columns, in any order: an index on
 * (a, b, c) serves a key on (b, a), not one on (b) or (a, c). A partial index (some rows only) and a full-text or
 * spatial one (not of the values) do not serve a join.
 */
function indexed(schema: Pick<TableSchema, 'primaryKey' | 'indexes'>, columns: readonly string[]): boolean {
  const wanted = new Set(columns)
  const starts = (cols: readonly string[]) =>
    cols.length >= wanted.size && cols.slice(0, wanted.size).every((c) => wanted.has(c))
  const serves = (i: IndexDef) => i.predicate === null && !/^(fulltext|spatial)$/i.test(i.type ?? '')
  return starts(schema.primaryKey) || schema.indexes.some((i) => serves(i) && starts(i.columns))
}

/**
 * What a database looks like from its definitions alone: how many tables of each role (guessed from their keys,
 * `tableRole`), which are referred to most, which have no primary key, and which foreign keys no index starts with.
 * Sequences are left out (no columns); views are counted, not given a role.
 */
export function databaseMap(
  schemas: readonly TableSchema[],
  /** The namespace shown (`homeNamespace`): a key into another one is to another table. */
  home: (ns: Namespace) => boolean
): DatabaseMap {
  const byName = (a: string, b: string) => a.localeCompare(b)
  const tables = schemas.filter((s) => s.kind === 'table').sort((a, b) => byName(a.name, b.name))
  const roles = Object.fromEntries(ROLE_ORDER.map((r) => [r, [] as string[]])) as Record<TableRole, string[]>
  const hubs: DatabaseMap['hubs'] = []
  for (const s of tables) {
    const guess = tableRole(s, home)
    roles[guess.role].push(s.name)
    if (guess.referredBy > 0) hubs.push({ table: s.name, referredBy: guess.referredBy })
  }
  hubs.sort((a, b) => b.referredBy - a.referredBy || byName(a.table, b.table))
  return {
    tables: tables.length,
    views: schemas.filter((s) => s.kind === 'view' || s.kind === 'materialized_view').length,
    roles,
    hubs: hubs.slice(0, HUBS_SHOWN),
    noPrimaryKey: tables.filter((s) => s.primaryKey.length === 0).map((s) => s.name),
    unindexedKeys: tables.flatMap((s) =>
      s.foreignKeys
        .filter((k) => k.columns.length > 0 && !indexed(s, k.columns))
        .map((k) => ({ table: s.name, key: k.name, columns: k.columns, refTable: k.refTable }))
    ),
  }
}
