import type { Dialect, Privilege, UserOp, UserRef } from '@tsmyadmin/shared'
import { PRIVILEGES } from '@tsmyadmin/shared'

/** One line of an account's grants below the server level, as the "database privileges" list shows it. */
export interface DatabaseGrant {
  /** MySQL: the database (or a pattern such as `shop\_%`). PostgreSQL: null — the database the session is in. */
  database: string | null
  /** PostgreSQL: the schema. */
  schema?: string
  /** A table, or a routine; null when the grant covers the whole database (MySQL) or schema (PostgreSQL). */
  object: string | null
  kind: 'database' | 'schema' | 'table' | 'routine'
  privileges: string[]
  grantOption: boolean
}

const IDENT = '(`(?:[^`]|``)*`|"(?:[^"]|"")*"|\\*|[^.\\s]+)'
const MYSQL = new RegExp(`^GRANT (.+?) ON (?:(TABLE|PROCEDURE|FUNCTION) )?${IDENT}\\.${IDENT} TO `, 'i')
const PG_SCHEMA = new RegExp(`^GRANT (.+?) ON SCHEMA ${IDENT} TO `, 'i')
const PG_TABLE = new RegExp(`^GRANT (.+?) ON ${IDENT}\\.${IDENT} TO `, 'i')

const unquote = (text: string) =>
  text.startsWith('`')
    ? text.slice(1, -1).replaceAll('``', '`')
    : text.startsWith('"')
      ? text.slice(1, -1).replaceAll('""', '"')
      : text

/** The privileges of a grant's list, split on the commas that are not inside a column list `SELECT (a, b)`. */
export function splitPrivileges(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}

/**
 * What an account holds on databases, schemas, tables and routines, read from its grant statements (server-wide
 * `*.*` grants have their own dialog, and a bare USAGE says nothing). PostgreSQL lists only the database the session is
 * connected to: that is where its ACLs are read.
 */
export function databaseGrants(dialect: Dialect, statements: readonly string[]): DatabaseGrant[] {
  const out: DatabaseGrant[] = []
  for (const statement of statements) {
    const grantOption = / WITH GRANT OPTION\s*$/i.test(statement)
    if (dialect === 'mysql') {
      const m = MYSQL.exec(statement)
      if (!m || (m[3] === '*' && m[4] === '*')) continue
      const privileges = splitPrivileges(m[1] ?? '').filter((p) => p.toUpperCase() !== 'USAGE')
      if (privileges.length === 0) continue
      const routine = m[2] && m[2].toUpperCase() !== 'TABLE'
      out.push({
        database: unquote(m[3] ?? ''),
        object: m[4] === '*' ? null : unquote(m[4] ?? ''),
        kind: m[4] === '*' ? 'database' : routine ? 'routine' : 'table',
        privileges,
        grantOption,
      })
      continue
    }
    const schema = PG_SCHEMA.exec(statement)
    if (schema) {
      out.push({
        database: null,
        schema: unquote(schema[2] ?? ''),
        object: null,
        kind: 'schema',
        privileges: splitPrivileges(schema[1] ?? ''),
        grantOption,
      })
      continue
    }
    const table = PG_TABLE.exec(statement)
    if (table && !/^GRANT \S+ TO /.test(statement)) {
      out.push({
        database: null,
        schema: unquote(table[2] ?? ''),
        object: unquote(table[3] ?? ''),
        kind: 'table',
        privileges: splitPrivileges(table[1] ?? ''),
        grantOption,
      })
    }
  }
  return out
}

/**
 * The database a `db.*` grant names, when it names exactly one. SHOW GRANTS prints `_` and `%` escaped for a literal
 * name (`shop\_1`) and bare for a pattern (`shop_%`); a pattern has no single database to open or to revoke on.
 */
function literalDatabase(name: string): string | null {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] as string
    if (ch === '\\') {
      out += name[i + 1] ?? ''
      i++
    } else if (ch === '%' || ch === '_') return null
    else out += ch
  }
  return out
}

/** The one database a MySQL row is about, or null for a `db.*` pattern. Table and routine grants name it literally. */
export const grantDatabase = (g: DatabaseGrant): string | null =>
  g.database === null ? null : g.kind === 'database' ? literalDatabase(g.database) : g.database

/** The op that takes a row's privileges away, or null when the row has no plain form of one (patterns, column lists, routines). */
export function revokeOp(user: UserRef, dialect: Dialect, grant: DatabaseGrant, connected: string): UserOp | null {
  const database = dialect === 'mysql' ? grantDatabase(grant) : connected
  if (database === null || grant.kind === 'routine') return null
  if (grant.kind === 'database' && dialect === 'mysql') return { op: 'revokeAll', user, database }
  if (grant.kind === 'schema') return { op: 'revokeAll', user, database, schema: grant.schema as string }
  const privileges = grant.privileges.filter((p): p is Privilege => (PRIVILEGES as readonly string[]).includes(p))
  if (privileges.length !== grant.privileges.length || grant.object === null) return null
  return {
    op: 'revokePrivileges',
    user,
    privileges,
    database,
    ...(grant.schema ? { schema: grant.schema } : {}),
    table: grant.object,
  }
}
