import { useQuery } from '@tanstack/react-query'
import { capabilities, type Dialect } from '@tsmyadmin/shared'
import { databasesQuery, schemasQuery } from './queries.ts'

/** The place a table lives in, as far as the choice of another one goes: where it is, and where it could go. */
export interface Spaces {
  /** What a table can be moved, copied or pointed to on this server: the other databases on MySQL, the schemas of this database on PostgreSQL. */
  names: string[]
  /** Where the table is now. */
  own: string
  /** True where a database is what the other server calls a schema (MySQL): the choice is among databases. */
  databasesAreSchemas: boolean
  /** The database and schema a `space` stands for (a MySQL database has no schema; a PostgreSQL schema is in this database). */
  locate(space: string): { db: string; schema: string | undefined }
  /** How a copy names its destination in an op. */
  copyTarget(space: string): { toDatabase: string } | { toSchema: string }
  /** How a foreign key names the namespace of the table it points to. */
  referenceTarget(space: string): { refDatabase: string } | { refSchema: string }
}

/**
 * The places to choose from when a table is moved, copied or referenced: loaded the one way the server has them, and
 * named in the one way an op takes them. Four screens made this choice with the same dozen lines each.
 */
export function useSpaces(dialect: Dialect, table: { db: string; schema?: string | undefined }): Spaces {
  const { databasesAreSchemas } = capabilities(dialect)
  const databases = useQuery({ ...databasesQuery, enabled: databasesAreSchemas })
  const schemas = useQuery({ ...schemasQuery(table.db), enabled: !databasesAreSchemas })
  return {
    names: databasesAreSchemas ? (databases.data ?? []).map((d) => d.name) : (schemas.data ?? []),
    own: databasesAreSchemas ? table.db : (table.schema ?? 'public'),
    databasesAreSchemas,
    locate: (space) => (databasesAreSchemas ? { db: space, schema: undefined } : { db: table.db, schema: space }),
    copyTarget: (space) => (databasesAreSchemas ? { toDatabase: space } : { toSchema: space }),
    referenceTarget: (space) => (databasesAreSchemas ? { refDatabase: space } : { refSchema: space }),
  }
}
