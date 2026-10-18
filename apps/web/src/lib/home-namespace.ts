import type { Dialect, Namespace } from '@tsmyadmin/shared'
import { capabilities } from '@tsmyadmin/shared'

/**
 * Whether a namespace a key names (`refNamespace`, `fromNamespace`) is the one a page shows: a key may point into
 * another database (MySQL) or schema (PostgreSQL), at a table of the same name as one here.
 */
export function homeNamespace(dialect: Dialect, ns: Namespace): (other: Namespace) => boolean {
  // PostgreSQL reports the schema of every referenced table; a page opened without one is showing public.
  const schema = capabilities(dialect).databasesAreSchemas ? undefined : (ns.schema ?? 'public')
  return (other) => other.database === ns.database && other.schema === schema
}
