import { useQuery } from '@tanstack/react-query'
import type { ServerCatalog } from '@tsmyadmin/shared'
import { serverCatalogQuery } from './queries.ts'

/** The collation names in the server's catalog, found by the column's name (MySQL lists the character set first). */
export function collationNames(catalog: ServerCatalog | undefined): string[] {
  const at = catalog?.columns.indexOf('collation') ?? -1
  if (!catalog || at < 0) return []
  return catalog.rows.map((r) => String(r[at] ?? '')).filter((n) => n !== '')
}

/** The server's collations, for a `<datalist>` under a collation field; nothing is fetched while `enabled` is false. */
export function useCollationNames(enabled = true): string[] {
  const catalog = useQuery({ ...serverCatalogQuery('collations'), enabled })
  return collationNames(catalog.data)
}
