import type { DatabaseInfo } from '@tsmyadmin/shared'

export type DatabaseColumn = 'name' | 'sizeBytes' | 'tableCount'

/** The list ordered by one column; a database without the figure (not counted, or not readable) goes last either way. */
export function sortDatabases(
  list: readonly DatabaseInfo[],
  column: DatabaseColumn,
  dir: 'asc' | 'desc'
): DatabaseInfo[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    if (column === 'name') return sign * a.name.localeCompare(b.name)
    const x = a[column]
    const y = b[column]
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    return sign * (x - y)
  })
}
