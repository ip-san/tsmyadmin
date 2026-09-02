import type { Namespace, UserInfo, UserOp, UserRef } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { quoteIdent } from '../sql/quote.ts'
import { AdapterError, type UserSqlBuilder, type UserStatement } from '../types.ts'

/** 'user'@'host' account literal. */
export function mysqlAccount(user: UserRef): string {
  return `${mysqlLiteral(user.name)}@${mysqlLiteral(user.host ?? '%')}`
}

const USERS_MYSQL = 'SELECT User, Host, account_locked, password_expired FROM mysql.user ORDER BY User, Host'
/**
 * MariaDB 10.4+: mysql.user is a view over mysql.global_priv without account_locked (the lock lives in the
 * Priv JSON); roles appear there too (is_role = 'Y', empty Host) and are not login accounts.
 */
const USERS_MARIADB =
  "SELECT u.User, u.Host, IF(JSON_VALUE(g.Priv, '$.account_locked') = 1, 'Y', 'N') AS account_locked, u.password_expired FROM mysql.user u JOIN mysql.global_priv g ON g.User = u.User AND g.Host = u.Host WHERE u.is_role <> 'Y' ORDER BY u.User, u.Host"

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
    return { name: String(row[0]), host: String(row[1]), canLogin: String(row[2]) !== 'Y', attributes }
  })
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

const grantPattern = (database: string) =>
  database.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%')

export const mysqlUsers: UserSqlBuilder = {
  namespace(_op: UserOp, serverNamespace: Namespace): Namespace {
    return serverNamespace
  },
  build(op: UserOp): UserStatement[] {
    const account = mysqlAccount(op.user)
    switch (op.op) {
      case 'createUser': {
        const out = [secret((pw) => `CREATE USER ${account} IDENTIFIED BY ${pw}`, op.password)]
        if (op.attributes.superuser) out.push(plain(`GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION`))
        else if (op.attributes.createdb) out.push(plain(`GRANT CREATE ON *.* TO ${account}`))
        if (op.attributes.createrole) out.push(plain(`GRANT CREATE USER ON *.* TO ${account}`))
        return out
      }
      case 'dropUser':
        return [plain(`DROP USER ${account}`)]
      case 'setPassword':
        return [secret((pw) => `ALTER USER ${account} IDENTIFIED BY ${pw}`, op.password)]
      // The database part of a GRANT is a LIKE pattern: escape _ and % so `my_db` does not also cover `myXdb`.
      case 'grantAll':
        return [plain(`GRANT ALL PRIVILEGES ON ${quoteIdent('mysql', grantPattern(op.database))}.* TO ${account}`)]
      case 'revokeAll':
        return [plain(`REVOKE ALL PRIVILEGES ON ${quoteIdent('mysql', grantPattern(op.database))}.* FROM ${account}`)]
    }
  },
}
