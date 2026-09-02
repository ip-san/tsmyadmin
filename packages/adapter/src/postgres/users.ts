import type { Namespace, UserInfo, UserOp, UserRef } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { pgLiteral } from '../sql/literal.ts'
import { quoteIdent } from '../sql/quote.ts'
import type { UserSqlBuilder, UserStatement } from '../types.ts'

const id = (s: string) => quoteIdent('postgres', s)

export async function pgListUsers(conn: Conn): Promise<UserInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolvaliduntil
       FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`
    )
  )
  return r.rows.map((row) => {
    const attributes: string[] = []
    if (row[1] === true) attributes.push('SUPERUSER')
    if (row[2] === true) attributes.push('CREATEROLE')
    if (row[3] === true) attributes.push('CREATEDB')
    if (row[4] !== true) attributes.push('NOLOGIN')
    if (row[5] !== null && row[5] !== undefined && String(row[5]) !== 'infinity')
      attributes.push(`VALID UNTIL ${String(row[5])}`)
    return { name: String(row[0]), host: null, canLogin: row[4] === true, attributes }
  })
}

/** Role attributes, memberships and table/schema grants in the current database, as SQL. */
export async function pgShowGrants(conn: Conn, user: UserRef): Promise<string[]> {
  const role = firstResult(
    await conn.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit,
              current_database(), has_database_privilege($1, current_database(), 'CREATE')
       FROM pg_roles WHERE rolname = $1`,
      [user.name]
    )
  )
  const attrs = role.rows[0]
  if (!attrs) return []
  const flags = [
    attrs[0] === true ? 'SUPERUSER' : 'NOSUPERUSER',
    attrs[1] === true ? 'CREATEROLE' : 'NOCREATEROLE',
    attrs[2] === true ? 'CREATEDB' : 'NOCREATEDB',
    attrs[3] === true ? 'LOGIN' : 'NOLOGIN',
    attrs[4] === true ? 'INHERIT' : 'NOINHERIT',
  ]
  const out = [`ALTER ROLE ${id(user.name)} ${flags.join(' ')}`]
  const members = firstResult(
    await conn.query(
      `SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
       WHERE r.rolname = $1 ORDER BY b.rolname`,
      [user.name]
    )
  )
  for (const row of members.rows) out.push(`GRANT ${id(String(row[0]))} TO ${id(user.name)}`)
  if (attrs[6] === true) out.push(`GRANT CREATE ON DATABASE ${id(String(attrs[5]))} TO ${id(user.name)}`)
  const schemas = firstResult(
    await conn.query(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND nspname NOT LIKE 'pg\\_%'
         AND has_schema_privilege($1, nspname, 'USAGE') ORDER BY nspname`,
      [user.name]
    )
  )
  for (const row of schemas.rows) out.push(`GRANT USAGE ON SCHEMA ${id(String(row[0]))} TO ${id(user.name)}`)
  // Read the ACLs directly: information_schema.role_table_grants only shows rows where the *connecting* role is
  // the grantor, the grantee or a member of it, so grants made by another owner would be silently missing.
  const tables = firstResult(
    await conn.query(
      `SELECT n.nspname, c.relname, string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
       GROUP BY n.nspname, c.relname ORDER BY n.nspname, c.relname`,
      [user.name]
    )
  )
  for (const row of tables.rows)
    out.push(`GRANT ${String(row[2])} ON ${id(String(row[0]))}.${id(String(row[1]))} TO ${id(user.name)}`)
  return out
}

const plain = (sql: string): UserStatement => ({ sql, display: sql })
/** Statement with a password: `display` carries the mask, `sql` the real value. */
const secret = (template: (password: string) => string, password: string): UserStatement => ({
  sql: template(pgLiteral(password)),
  display: template(pgLiteral(PASSWORD_MASK)),
})

export const pgUsers: UserSqlBuilder = {
  namespace(op: UserOp, serverNamespace: Namespace): Namespace {
    if (op.op === 'grantAll' || op.op === 'revokeAll')
      return op.schema ? { database: op.database, schema: op.schema } : { database: op.database }
    return serverNamespace
  },
  build(op: UserOp): UserStatement[] {
    const role = id(op.user.name)
    switch (op.op) {
      case 'createUser': {
        const flags = ['LOGIN']
        if (op.attributes.superuser) flags.push('SUPERUSER')
        if (op.attributes.createdb) flags.push('CREATEDB')
        if (op.attributes.createrole) flags.push('CREATEROLE')
        return [secret((pw) => `CREATE ROLE ${role} ${flags.join(' ')} PASSWORD ${pw}`, op.password)]
      }
      case 'dropUser':
        return [plain(`DROP ROLE ${role}`)]
      case 'setPassword':
        return [secret((pw) => `ALTER ROLE ${role} PASSWORD ${pw}`, op.password)]
      case 'grantAll': {
        const schema = id(op.schema ?? 'public')
        return [
          `GRANT CONNECT, TEMP ON DATABASE ${id(op.database)} TO ${role}`,
          `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`,
          `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
          `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL PRIVILEGES ON TABLES TO ${role}`,
        ].map(plain)
      }
      case 'revokeAll': {
        const schema = id(op.schema ?? 'public')
        return [
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`,
          `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`,
          `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
          `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role}`,
          `REVOKE ALL PRIVILEGES ON DATABASE ${id(op.database)} FROM ${role}`,
        ].map(plain)
      }
    }
  },
}
