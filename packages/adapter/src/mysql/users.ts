import type { Namespace, UserInfo, UserOp, UserRef } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { quoteIdent } from '../sql/quote.ts'
import type { UserSqlBuilder } from '../types.ts'

/** 'user'@'host' account literal. */
function mysqlAccount(user: UserRef): string {
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

export const mysqlUsers: UserSqlBuilder = {
  namespace(_op: UserOp, defaultDatabase: string): Namespace {
    return { database: defaultDatabase }
  },
  build(op: UserOp, options = {}): string[] {
    const account = mysqlAccount(op.user)
    const pw = (p: string) => mysqlLiteral(options.mask ? PASSWORD_MASK : p)
    switch (op.op) {
      case 'createUser': {
        const out = [`CREATE USER ${account} IDENTIFIED BY ${pw(op.password)}`]
        if (op.attributes.superuser) out.push(`GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION`)
        else if (op.attributes.createdb) out.push(`GRANT CREATE ON *.* TO ${account}`)
        if (op.attributes.createrole) out.push(`GRANT CREATE USER ON *.* TO ${account}`)
        return out
      }
      case 'dropUser':
        return [`DROP USER ${account}`]
      case 'setPassword':
        return [`ALTER USER ${account} IDENTIFIED BY ${pw(op.password)}`]
      case 'grantAll':
        return [`GRANT ALL PRIVILEGES ON ${quoteIdent('mysql', op.database)}.* TO ${account}`]
      case 'revokeAll':
        return [`REVOKE ALL PRIVILEGES ON ${quoteIdent('mysql', op.database)}.* FROM ${account}`]
    }
  },
}
