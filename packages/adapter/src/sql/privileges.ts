import type { Dialect } from '@tsmyadmin/shared'
import { quoteIdent } from './quote.ts'

/**
 * The privilege list of a GRANT / REVOKE. Naming columns attaches the same list to each privilege, which is the
 * form both servers take (`GRANT SELECT (a, b), UPDATE (a, b) ON …`). Columns are plain identifiers: the LIKE
 * escaping that a MySQL database pattern needs must never be applied to them.
 */
export function privilegeList(dialect: Dialect, privileges: readonly string[], columns?: readonly string[]): string {
  if (!columns || columns.length === 0) return privileges.join(', ')
  const list = columns.map((c) => quoteIdent(dialect, c)).join(', ')
  return privileges.map((p) => `${p} (${list})`).join(', ')
}
