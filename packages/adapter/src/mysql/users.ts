import type { Namespace, UserInfo, UserOp, UserRef } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { quoteIdent } from '../sql/quote.ts'
import type { UserSqlBuilder, UserStatement } from '../types.ts'

/** 'user'@'host' account literal. */
export function mysqlAccount(user: UserRef): string {
  return `${mysqlLiteral(user.name)}@${mysqlLiteral(user.host ?? '%')}`
}

export async function mysqlListUsers(conn: Conn): Promise<UserInfo[]> {
  const r = firstResult(
    await conn.query('SELECT User, Host, account_locked, password_expired FROM mysql.user ORDER BY User, Host')
  )
  return r.rows.map((row) => {
    const attributes: string[] = []
    if (String(row[2]) === 'Y') attributes.push('LOCKED')
    if (String(row[3]) === 'Y') attributes.push('EXPIRED')
    return { name: String(row[0]), host: String(row[1]), canLogin: String(row[2]) !== 'Y', attributes }
  })
}

export async function mysqlShowGrants(conn: Conn, user: UserRef): Promise<string[]> {
  const r = firstResult(await conn.query(`SHOW GRANTS FOR ${mysqlAccount(user)}`))
  return r.rows.map((row) => String(row[0] ?? ''))
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
