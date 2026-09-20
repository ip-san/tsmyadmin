import type { Namespace, UserInfo, UserOp, UserRef } from '@tsmyadmin/shared'
import { PASSWORD_MASK, SYSTEM_DATABASES } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { privilegeList } from '../sql/privileges.ts'
import { quoteIdent } from '../sql/quote.ts'
import { AdapterError, type UserSqlBuilder, type UserStatement } from '../types.ts'

/** 'user'@'host' account literal. */
export function mysqlAccount(user: UserRef): string {
  return `${mysqlLiteral(user.name)}@${mysqlLiteral(user.host ?? '%')}`
}

const USERS_MYSQL =
  'SELECT User, Host, account_locked, password_expired, ssl_type, max_questions, max_updates, max_connections, max_user_connections FROM mysql.user ORDER BY User, Host'
/**
 * MariaDB 10.4+: mysql.user is a view over mysql.global_priv without account_locked (the lock lives in the
 * Priv JSON); roles appear there too (is_role = 'Y', empty Host) and are not login accounts. The literal is
 * binary: the view's columns carry the server's collation, which need not be the session's (MariaDB 10.11
 * refuses to compare utf8mb4_general_ci with the connection's utf8mb4_unicode_ci).
 */
const USERS_MARIADB =
  "SELECT u.User, u.Host, IF(JSON_VALUE(g.Priv, '$.account_locked') = 1, 'Y', 'N') AS account_locked, u.password_expired, u.ssl_type, u.max_questions, u.max_updates, u.max_connections, u.max_user_connections FROM mysql.user u JOIN mysql.global_priv g ON g.User = u.User AND g.Host = u.Host WHERE u.is_role <> _binary'Y' ORDER BY u.User, u.Host"

/** Password hashes MariaDB prints inside SHOW GRANTS (MySQL 8 never does); not for the privileges screen. */
const GRANT_SECRET = / IDENTIFIED (?:BY PASSWORD '[^']*'|VIA \S+ USING '[^']*')/g

/** Connections whose mysql.user has no account_locked column (MariaDB): the MySQL form is not retried on them. */
const MARIADB_USER_TABLE = new WeakSet<object>()

export async function mysqlListUsers(conn: Conn): Promise<UserInfo[]> {
  let r: ReturnType<typeof firstResult> | undefined
  if (!MARIADB_USER_TABLE.has(conn.id)) {
    try {
      r = firstResult(await conn.query(USERS_MYSQL))
    } catch (err) {
      if (!(err instanceof AdapterError) || err.nativeCode !== 'ER_BAD_FIELD_ERROR') throw err
      MARIADB_USER_TABLE.add(conn.id)
    }
  }
  if (r === undefined) r = firstResult(await conn.query(USERS_MARIADB))
  return r.rows.map((row) => {
    const attributes: string[] = []
    if (String(row[2]) === 'Y') attributes.push('LOCKED')
    if (String(row[3]) === 'Y') attributes.push('EXPIRED')
    const ssl = String(row[4] ?? '')
    return {
      name: String(row[0]),
      host: String(row[1]),
      canLogin: String(row[2]) !== 'Y',
      attributes,
      limits: {
        require: ssl === 'X509' ? 'X509' : ssl === '' ? 'NONE' : 'SSL',
        maxQueries: Number(row[5] ?? 0),
        maxUpdates: Number(row[6] ?? 0),
        maxConnections: Number(row[7] ?? 0),
        maxUserConnections: Number(row[8] ?? 0),
      },
    }
  })
}

/**
 * Global CREATE USER, plus SYSTEM_USER on servers that have it (MySQL 8.0.16+): without it, an account that
 * holds SYSTEM_USER cannot be altered, and which of the accounts behind a login name hold it is not visible to
 * everyone. The grantee is rebuilt from CURRENT_USER() in the `'user'@'host'` form USER_PRIVILEGES uses; the
 * host is what follows the last `@` (a host cannot contain one).
 */
export async function mysqlCanManageAccount(conn: Conn): Promise<boolean> {
  const r = firstResult(
    await conn.query(
      `SELECT p.PRIVILEGE_TYPE, VERSION()
       FROM (SELECT CURRENT_USER() AS u) AS me
       LEFT JOIN information_schema.USER_PRIVILEGES p
         ON p.GRANTEE = CONCAT('''', LEFT(me.u, CHAR_LENGTH(me.u) - CHAR_LENGTH(SUBSTRING_INDEX(me.u, '@', -1)) - 1),
                               '''@''', SUBSTRING_INDEX(me.u, '@', -1), '''')
        AND p.PRIVILEGE_TYPE IN ('CREATE USER', 'SYSTEM_USER')`
    )
  )
  const held = new Set(r.rows.map((row) => String(row[0] ?? '')))
  const version = String(r.rows[0]?.[1] ?? '')
  return held.has('CREATE USER') && (!hasSystemUser(version) || held.has('SYSTEM_USER'))
}

/**
 * SYSTEM_USER exists from MySQL 8.0.16; MariaDB has no such privilege. A version this cannot read (a proxy or a
 * fork answering VERSION() its own way) is taken to have it: the check then asks for more, never for less.
 */
export function hasSystemUser(version: string): boolean {
  if (/mariadb/i.test(version)) return false
  const [major, minor, patch] = version.split(/[.-]/).map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return true
  return (major as number) > 8 || (major === 8 && ((minor as number) > 0 || (patch as number) >= 16))
}

export async function mysqlShowGrants(conn: Conn, user: UserRef): Promise<string[]> {
  const r = firstResult(await conn.query(`SHOW GRANTS FOR ${mysqlAccount(user)}`))
  return r.rows.map((row) => String(row[0] ?? '').replace(GRANT_SECRET, ''))
}

const plain = (sql: string): UserStatement => ({ sql, display: sql })
/** Statement with a password: `display` carries the mask, `sql` the real value. */
const secret = (template: (password: string) => string, password: string): UserStatement => ({
  sql: template(mysqlLiteral(password)),
  display: template(mysqlLiteral(PASSWORD_MASK)),
})

/** An account as SHOW GRANTS prints it: `user`@`host` (MySQL 8) or 'user'@'host' (MariaDB). */
const ACCOUNT_IN_GRANT = /(`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*')@(`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*')/g

/**
 * A GRANT of the source account, pointed at another account: what follows the last ` TO ` (or, for a REVOKE-free
 * SHOW GRANTS, the only account named there) is replaced. Statements that name no account are left alone.
 */
function retargetGrant(statement: string, account: string): string {
  const at = statement.lastIndexOf(' TO ')
  if (at === -1) return statement
  const tail = statement.slice(at + 4).replace(ACCOUNT_IN_GRANT, () => account)
  return statement.slice(0, at + 4) + tail
}

const grantPattern = (database: string) =>
  database.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%')

/** Several accounts dropped in one statement, after taking their privileges away and/or with their same-named databases. */
function dropUsers(op: Extract<UserOp, { op: 'dropUsers' }>): UserStatement[] {
  const accounts = op.users.map(mysqlAccount)
  const out: UserStatement[] = []
  if (op.revokeFirst) for (const a of accounts) out.push(plain(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${a}`))
  out.push(plain(`DROP USER ${accounts.join(', ')}`))
  if (op.dropSameNameDatabases) {
    const names = [...new Set(op.users.map((u) => u.name))]
    // An account named like a system schema must not take it with it.
    const system = names.find((n) => SYSTEM_DATABASES.mysql.has(n.toLowerCase()))
    if (system !== undefined)
      throw new AdapterError('VALIDATION', `The database ${system} is a system database and is never dropped`)
    // IF EXISTS: not every account has a database of its name, and the ones that do not must not stop the rest.
    for (const name of names) out.push(plain(`DROP DATABASE IF EXISTS ${quoteIdent('mysql', name)}`))
  }
  return out
}

export const mysqlUsers: UserSqlBuilder = {
  namespace(_op: UserOp, serverNamespace: Namespace): Namespace {
    return serverNamespace
  },
  build(op: UserOp): UserStatement[] {
    if (op.op === 'dropUsers') return dropUsers(op)
    const account = mysqlAccount(op.user)
    switch (op.op) {
      case 'createUser': {
        const identified = op.plugin ? `IDENTIFIED WITH ${op.plugin} BY` : 'IDENTIFIED BY'
        const out = [secret((pw) => `CREATE USER ${account} ${identified} ${pw}`, op.password)]
        // A database of the account's own name, and/or every database that starts with `name_`.
        if (op.createDatabase) {
          out.push(plain(`CREATE DATABASE ${quoteIdent('mysql', op.user.name)}`))
          out.push(plain(`GRANT ALL PRIVILEGES ON ${quoteIdent('mysql', grantPattern(op.user.name))}.* TO ${account}`))
        }
        if (op.grantWildcard)
          out.push(
            plain(`GRANT ALL PRIVILEGES ON ${quoteIdent('mysql', `${grantPattern(op.user.name)}\\_%`)}.* TO ${account}`)
          )
        if (op.attributes.superuser) out.push(plain(`GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION`))
        else if (op.attributes.createdb) out.push(plain(`GRANT CREATE ON *.* TO ${account}`))
        if (op.attributes.createrole) out.push(plain(`GRANT CREATE USER ON *.* TO ${account}`))
        if (op.replication) out.push(plain(`GRANT REPLICATION SLAVE ON *.* TO ${account}`))
        return out
      }
      case 'dropUser':
        return [plain(`DROP USER ${account}`)]
      case 'lockUser':
        return [plain(`ALTER USER ${account} ACCOUNT ${op.locked ? 'LOCK' : 'UNLOCK'}`)]
      case 'renameUser':
        return [plain(`RENAME USER ${account} TO ${mysqlAccount(op.newUser)}`)]
      case 'copyUser': {
        if (!op.grants) throw new AdapterError('VALIDATION', 'copyUser needs the grants of the account to copy')
        const target = mysqlAccount(op.newUser)
        return [
          secret((pw) => `CREATE USER ${target} IDENTIFIED BY ${pw}`, op.password),
          // USAGE alone says only that the account exists: CREATE USER has already done that.
          ...op.grants
            .filter((g) => !/^GRANT USAGE ON \*\.\* TO [^ ]+$/.test(g))
            .map((g) => plain(retargetGrant(g, target))),
        ]
      }
      case 'setAccountLimits': {
        const limits = [
          op.maxQueries !== undefined ? `MAX_QUERIES_PER_HOUR ${op.maxQueries}` : '',
          op.maxUpdates !== undefined ? `MAX_UPDATES_PER_HOUR ${op.maxUpdates}` : '',
          op.maxConnections !== undefined ? `MAX_CONNECTIONS_PER_HOUR ${op.maxConnections}` : '',
          op.maxUserConnections !== undefined ? `MAX_USER_CONNECTIONS ${op.maxUserConnections}` : '',
        ].filter((x) => x !== '')
        if (op.require === undefined && limits.length === 0)
          throw new AdapterError('VALIDATION', 'No account limit or requirement to change')
        return [
          plain(
            `ALTER USER ${account}${op.require ? ` REQUIRE ${op.require}` : ''}${limits.length > 0 ? ` WITH ${limits.join(' ')}` : ''}`
          ),
        ]
      }
      case 'changeGlobalPrivileges': {
        if (op.grant.length === 0 && op.revoke.length === 0)
          throw new AdapterError('VALIDATION', 'No global privilege to change')
        return [
          ...(op.grant.length > 0 ? [plain(`GRANT ${op.grant.join(', ')} ON *.* TO ${account}`)] : []),
          ...(op.revoke.length > 0 ? [plain(`REVOKE ${op.revoke.join(', ')} ON *.* FROM ${account}`)] : []),
        ]
      }
      case 'alterRole':
        throw new AdapterError('UNSUPPORTED', 'Role attributes are PostgreSQL’s: MySQL has global privileges')
      case 'grantRoutinePrivileges':
      case 'revokeRoutinePrivileges': {
        const routine = `${op.kind} ${quoteIdent('mysql', op.database)}.${quoteIdent('mysql', op.routine)}`
        const list = op.privileges.join(', ')
        return [
          plain(
            op.op === 'grantRoutinePrivileges'
              ? `GRANT ${list} ON ${routine} TO ${account}`
              : `REVOKE ${list} ON ${routine} FROM ${account}`
          ),
        ]
      }
      case 'setPassword':
        return [secret((pw) => `ALTER USER ${account} IDENTIFIED BY ${pw}`, op.password)]
      // The database part of a GRANT is a LIKE pattern: escape _ and % so `my_db` does not also cover `myXdb`.
      case 'grantAll':
        return [plain(`GRANT ALL PRIVILEGES ON ${quoteIdent('mysql', grantPattern(op.database))}.* TO ${account}`)]
      case 'revokeAll':
        return [plain(`REVOKE ALL PRIVILEGES ON ${quoteIdent('mysql', grantPattern(op.database))}.* FROM ${account}`)]
      case 'grantPrivileges':
      case 'revokePrivileges': {
        // `db.*` matches databases as a LIKE pattern, so `_` and `%` are escaped there. `db.tbl` names one
        // table and takes plain identifiers — escaping would look for a database with a backslash in its name.
        const target = op.table
          ? `${quoteIdent('mysql', op.database)}.${quoteIdent('mysql', op.table)}`
          : `${quoteIdent('mysql', grantPattern(op.database))}.*`
        const list = privilegeList('mysql', op.privileges, op.columns)
        if (op.op === 'grantPrivileges')
          return [plain(`GRANT ${list} ON ${target} TO ${account}${op.grantOption ? ' WITH GRANT OPTION' : ''}`)]
        // MySQL has no per-privilege grant option: it is one flag on the row, so the list is not part of the statement.
        if (op.grantOption && op.columns)
          throw new AdapterError('VALIDATION', 'MySQL keeps the grant option per table or database, not per column')
        if (op.grantOption) return [plain(`REVOKE GRANT OPTION ON ${target} FROM ${account}`)]
        return [plain(`REVOKE ${list} ON ${target} FROM ${account}`)]
      }
    }
  },
}
