import type { TableInfo } from '@tsmyadmin/shared'

export type NavEntry = { kind: 'table'; table: TableInfo } | { kind: 'group'; prefix: string; tables: TableInfo[] }

/**
 * Tables whose names start alike (up to the first `delimiter`) gathered under that prefix, in the order the prefix first
 * appears. A prefix shared by only one table is not worth a node of its own: that table stays where it was. An
 * empty delimiter groups nothing.
 */
export function groupTables(tables: TableInfo[], delimiter: string): NavEntry[] {
  if (delimiter === '') return tables.map((table) => ({ kind: 'table', table }))
  const prefixOf = (name: string) => {
    const at = name.indexOf(delimiter)
    return at > 0 ? name.slice(0, at) : null
  }
  const members = new Map<string, TableInfo[]>()
  for (const table of tables) {
    const prefix = prefixOf(table.name)
    if (prefix !== null) members.set(prefix, [...(members.get(prefix) ?? []), table])
  }
  const out: NavEntry[] = []
  const placed = new Set<string>()
  for (const table of tables) {
    const prefix = prefixOf(table.name)
    const group = prefix === null ? undefined : members.get(prefix)
    if (prefix === null || !group || group.length < 2) out.push({ kind: 'table', table })
    else if (!placed.has(prefix)) {
      placed.add(prefix)
      out.push({ kind: 'group', prefix, tables: group })
    }
  }
  return out
}

/** The first `limit` entries, and how many are left. */
export function pageEntries<T>(entries: T[], limit: number): { shown: T[]; rest: number } {
  return { shown: entries.slice(0, limit), rest: Math.max(0, entries.length - limit) }
}
