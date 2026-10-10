import type { UserOp } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import {
  hasSystemUser,
  mysqlAccount,
  mysqlCanManageAccount,
  mysqlListUsers,
  mysqlShowGrants,
  mysqlUsers,
} from '../mysql/users.ts'
import { pgCanManageAccount, pgListUsers, pgShowGrants, pgUsers } from '../postgres/users.ts'
import { refuses } from './ddl-helpers.ts'
import { fail, rows, scripted } from './scripted-conn.ts'

/**
 * The details the one-sample-per-op snapshot in users.test.ts does not pin: each option of an account op, each
 * refusal, and what the readers make of the rows a server returns (answered by a scripted connection, since a real
 * server gives only one answer). Found as surviving mutants (see `bun run mutation`).
 */

type Target = Omit<Extract<UserOp, { op: 'grantPrivileges' }>, 'op'>
type RoutineTarget = Omit<Extract<UserOp, { op: 'grantRoutinePrivileges' }>, 'op'>

const u = { name: 'u', host: 'h' }
const my = (op: UserOp) => mysqlUsers.build(op)
const pg = (op: UserOp) => pgUsers.build(op)
const sqls = (list: { sql: string }[]) => list.map((s) => s.sql)
const plainAttrs = { superuser: false, createdb: false, createrole: false }

describe('mysqlAccount', () => {
  it("writes 'name'@'host', with % when no host is given, quoting both as literals", () => {
    expect(mysqlAccount({ name: 'u', host: 'h' })).toBe("'u'@'h'")
    expect(mysqlAccount({ name: 'u' })).toBe("'u'@'%'")
    expect(mysqlAccount({ name: "o'x", host: "a'b" })).toBe("'o''x'@'a''b'")
  })
})

describe('MySQL: creating an account', () => {
  const create = (extra: Record<string, unknown> = {}) =>
    my({ op: 'createUser', user: u, password: 'pw', attributes: plainAttrs, ...extra } as UserOp)

  it('creates the account with its password, shown masked in the preview, with a plugin when one is named', () => {
    const [stmt] = create()
    expect(stmt).toEqual({
      sql: "CREATE USER 'u'@'h' IDENTIFIED BY 'pw'",
      display: `CREATE USER 'u'@'h' IDENTIFIED BY '${PASSWORD_MASK}'`,
    })
    expect(sqls(create({ plugin: 'caching_sha2_password' }))).toEqual([
      "CREATE USER 'u'@'h' IDENTIFIED WITH caching_sha2_password BY 'pw'",
    ])
  })

  it('adds a database of the account name and its grant, escaping the LIKE characters of the name', () => {
    const user = { name: 'a_b%c\\d', host: 'h' }
    const out = sqls(my({ op: 'createUser', user, password: 'pw', attributes: plainAttrs, createDatabase: true }))
    // The database is named as is; in the grant it is a pattern, so _ % and \\ are escaped (and the account literal
    // doubles the backslash as every MySQL string does).
    expect(out.slice(1)).toEqual([
      'CREATE DATABASE `a_b%c\\d`',
      "GRANT ALL PRIVILEGES ON `a\\_b\\%c\\\\d`.* TO 'a_b%c\\\\d'@'h'",
    ])
    expect(sqls(create({ createDatabase: false }))).toHaveLength(1)
  })

  it('grants a wildcard of databases that begin with the name followed by an underscore', () => {
    expect(sqls(create({ grantWildcard: true })).slice(1)).toEqual(["GRANT ALL PRIVILEGES ON `u\\_%`.* TO 'u'@'h'"])
    expect(sqls(create({ grantWildcard: false }))).toHaveLength(1)
    expect(
      sqls(
        my({ op: 'createUser', user: { name: 'a_b' }, password: 'pw', attributes: plainAttrs, grantWildcard: true })
      )[1]
    ).toBe("GRANT ALL PRIVILEGES ON `a\\_b\\_%`.* TO 'a_b'@'%'")
  })

  it('grants by attribute: a superuser everything with the grant option, else CREATE for createdb', () => {
    expect(sqls(create({ attributes: { ...plainAttrs, superuser: true } })).slice(1)).toEqual([
      "GRANT ALL PRIVILEGES ON *.* TO 'u'@'h' WITH GRANT OPTION",
    ])
    expect(sqls(create({ attributes: { ...plainAttrs, superuser: true, createdb: true } })).slice(1)).toEqual([
      "GRANT ALL PRIVILEGES ON *.* TO 'u'@'h' WITH GRANT OPTION",
    ])
    expect(sqls(create({ attributes: { ...plainAttrs, createdb: true } })).slice(1)).toEqual([
      "GRANT CREATE ON *.* TO 'u'@'h'",
    ])
    expect(sqls(create({ attributes: { ...plainAttrs, createrole: true } })).slice(1)).toEqual([
      "GRANT CREATE USER ON *.* TO 'u'@'h'",
    ])
    expect(sqls(create({ replication: true })).slice(1)).toEqual(["GRANT REPLICATION SLAVE ON *.* TO 'u'@'h'"])
    expect(sqls(create({ replication: false }))).toHaveLength(1)
  })
})

describe('MySQL: other account ops', () => {
  it('drops, locks, unlocks and renames an account', () => {
    expect(sqls(my({ op: 'dropUser', user: u }))).toEqual(["DROP USER 'u'@'h'"])
    expect(sqls(my({ op: 'lockUser', user: u, locked: true }))).toEqual(["ALTER USER 'u'@'h' ACCOUNT LOCK"])
    expect(sqls(my({ op: 'lockUser', user: u, locked: false }))).toEqual(["ALTER USER 'u'@'h' ACCOUNT UNLOCK"])
    expect(sqls(my({ op: 'renameUser', user: u, newUser: { name: 'n' } }))).toEqual(["RENAME USER 'u'@'h' TO 'n'@'%'"])
  })

  it('sets a password, masked in the preview', () => {
    expect(my({ op: 'setPassword', user: u, password: "p'w" })).toEqual([
      {
        sql: "ALTER USER 'u'@'h' IDENTIFIED BY 'p''w'",
        display: `ALTER USER 'u'@'h' IDENTIFIED BY '${PASSWORD_MASK}'`,
      },
    ])
  })

  it('drops several accounts in one statement, taking their privileges first and their same-named databases after', () => {
    const users = [u, { name: 'v' }, { name: 'u', host: 'other' }]
    expect(sqls(my({ op: 'dropUsers', users }))).toEqual(["DROP USER 'u'@'h', 'v'@'%', 'u'@'other'"])
    expect(sqls(my({ op: 'dropUsers', users, revokeFirst: true, dropSameNameDatabases: true }))).toEqual([
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'u'@'h'",
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'v'@'%'",
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'u'@'other'",
      "DROP USER 'u'@'h', 'v'@'%', 'u'@'other'",
      'DROP DATABASE IF EXISTS `u`',
      'DROP DATABASE IF EXISTS `v`',
    ])
    expect(sqls(my({ op: 'dropUsers', users, revokeFirst: false, dropSameNameDatabases: false }))).toHaveLength(1)
  })

  it('never drops a system database along with an account of its name, in any case', () => {
    for (const name of ['mysql', 'MySQL', 'sys', 'performance_schema', 'information_schema']) {
      refuses(
        () => my({ op: 'dropUsers', users: [{ name: 'ok' }, { name }], dropSameNameDatabases: true }),
        'VALIDATION',
        new RegExp(`The database ${name} is a system database and is never dropped`)
      )
    }
    // Without the option the same account drops as any other.
    expect(sqls(my({ op: 'dropUsers', users: [{ name: 'mysql' }] }))).toEqual(["DROP USER 'mysql'@'%'"])
  })

  it('copies an account: a new one with the password, then the source grants pointed at it', () => {
    const grants = [
      'GRANT USAGE ON *.* TO `u`@`h`',
      'GRANT USAGE ON *.* TO `u`@`h` WITH GRANT OPTION',
      '-- GRANT USAGE ON *.* TO `u`@`h`',
      'GRANT SELECT ON `shop`.* TO `u`@`h`',
      "GRANT SELECT ON `a TO b`.* TO 'u'@'h' WITH GRANT OPTION",
      'SET DEFAULT ROLE `r` FOR `u`@`h`',
      'GRANT `role`@`%` TO `u`@`h`',
    ]
    const out = my({ op: 'copyUser', user: u, newUser: { name: 'n', host: 'x' }, password: 'pw', grants })
    expect(out[0]).toEqual({
      sql: "CREATE USER 'n'@'x' IDENTIFIED BY 'pw'",
      display: `CREATE USER 'n'@'x' IDENTIFIED BY '${PASSWORD_MASK}'`,
    })
    expect(sqls(out).slice(1)).toEqual([
      "GRANT USAGE ON *.* TO 'n'@'x' WITH GRANT OPTION",
      "-- GRANT USAGE ON *.* TO 'n'@'x'",
      "GRANT SELECT ON `shop`.* TO 'n'@'x'",
      "GRANT SELECT ON `a TO b`.* TO 'n'@'x' WITH GRANT OPTION",
      'SET DEFAULT ROLE `r` FOR `u`@`h`',
      "GRANT `role`@`%` TO 'n'@'x'",
    ])
    refuses(
      () => my({ op: 'copyUser', user: u, newUser: { name: 'n' }, password: 'pw' }),
      'VALIDATION',
      /needs the grants/
    )
    expect(sqls(my({ op: 'copyUser', user: u, newUser: { name: 'n' }, password: 'pw', grants: [] }))).toHaveLength(1)
  })

  it('sets the limits given, with REQUIRE first, and refuses a change of nothing', () => {
    expect(sqls(my({ op: 'setAccountLimits', user: u, require: 'SSL' }))).toEqual(["ALTER USER 'u'@'h' REQUIRE SSL"])
    expect(sqls(my({ op: 'setAccountLimits', user: u, require: 'NONE', maxQueries: 1 }))).toEqual([
      "ALTER USER 'u'@'h' REQUIRE NONE WITH MAX_QUERIES_PER_HOUR 1",
    ])
    expect(
      sqls(
        my({ op: 'setAccountLimits', user: u, maxQueries: 1, maxUpdates: 2, maxConnections: 3, maxUserConnections: 4 })
      )
    ).toEqual([
      "ALTER USER 'u'@'h' WITH MAX_QUERIES_PER_HOUR 1 MAX_UPDATES_PER_HOUR 2 MAX_CONNECTIONS_PER_HOUR 3 MAX_USER_CONNECTIONS 4",
    ])
    // A limit of 0 is a limit (none), not an absent one.
    expect(sqls(my({ op: 'setAccountLimits', user: u, maxUpdates: 0 }))).toEqual([
      "ALTER USER 'u'@'h' WITH MAX_UPDATES_PER_HOUR 0",
    ])
    expect(sqls(my({ op: 'setAccountLimits', user: u, maxConnections: 0 }))).toEqual([
      "ALTER USER 'u'@'h' WITH MAX_CONNECTIONS_PER_HOUR 0",
    ])
    expect(sqls(my({ op: 'setAccountLimits', user: u, maxUserConnections: 0 }))).toEqual([
      "ALTER USER 'u'@'h' WITH MAX_USER_CONNECTIONS 0",
    ])
    refuses(() => my({ op: 'setAccountLimits', user: u }), 'VALIDATION', /No account limit or requirement/)
  })

  it('grants and revokes global privileges, each side only when it has something', () => {
    expect(sqls(my({ op: 'changeGlobalPrivileges', user: u, grant: ['SELECT', 'PROCESS'], revoke: [] }))).toEqual([
      "GRANT SELECT, PROCESS ON *.* TO 'u'@'h'",
    ])
    expect(sqls(my({ op: 'changeGlobalPrivileges', user: u, grant: [], revoke: ['SUPER', 'FILE'] }))).toEqual([
      "REVOKE SUPER, FILE ON *.* FROM 'u'@'h'",
    ])
    expect(sqls(my({ op: 'changeGlobalPrivileges', user: u, grant: ['SELECT'], revoke: ['FILE'] }))).toEqual([
      "GRANT SELECT ON *.* TO 'u'@'h'",
      "REVOKE FILE ON *.* FROM 'u'@'h'",
    ])
    refuses(
      () => my({ op: 'changeGlobalPrivileges', user: u, grant: [], revoke: [] }),
      'VALIDATION',
      /No global privilege/
    )
    refuses(() => my({ op: 'alterRole', user: u, login: true }), 'UNSUPPORTED', /Role attributes are PostgreSQL/)
  })

  it('grants and revokes privileges on a routine', () => {
    const routine: RoutineTarget = {
      user: u,
      database: 'db',
      routine: 'r',
      kind: 'PROCEDURE',
      privileges: ['EXECUTE', 'ALTER ROUTINE'],
    }
    expect(sqls(my({ op: 'grantRoutinePrivileges', ...routine }))).toEqual([
      "GRANT EXECUTE, ALTER ROUTINE ON PROCEDURE `db`.`r` TO 'u'@'h'",
    ])
    expect(sqls(my({ op: 'revokeRoutinePrivileges', ...routine, kind: 'FUNCTION' }))).toEqual([
      "REVOKE EXECUTE, ALTER ROUTINE ON FUNCTION `db`.`r` FROM 'u'@'h'",
    ])
  })

  it('escapes the LIKE characters of a database pattern, and not the names of a table', () => {
    expect(sqls(my({ op: 'grantAll', user: u, database: 'a_b%c\\d' }))).toEqual([
      "GRANT ALL PRIVILEGES ON `a\\_b\\%c\\\\d`.* TO 'u'@'h'",
    ])
    expect(sqls(my({ op: 'revokeAll', user: u, database: 'a_b' }))).toEqual([
      "REVOKE ALL PRIVILEGES ON `a\\_b`.* FROM 'u'@'h'",
    ])
    const on: Target = { user: u, database: 'a_b', privileges: ['SELECT', 'UPDATE'] }
    expect(sqls(my({ op: 'grantPrivileges', ...on }))).toEqual(["GRANT SELECT, UPDATE ON `a\\_b`.* TO 'u'@'h'"])
    expect(sqls(my({ op: 'grantPrivileges', ...on, table: 't_1', grantOption: true }))).toEqual([
      "GRANT SELECT, UPDATE ON `a_b`.`t_1` TO 'u'@'h' WITH GRANT OPTION",
    ])
    expect(sqls(my({ op: 'grantPrivileges', ...on, table: 't', columns: ['c', 'd'] }))).toEqual([
      "GRANT SELECT (`c`, `d`), UPDATE (`c`, `d`) ON `a_b`.`t` TO 'u'@'h'",
    ])
    expect(sqls(my({ op: 'revokePrivileges', ...on, table: 't' }))).toEqual([
      "REVOKE SELECT, UPDATE ON `a_b`.`t` FROM 'u'@'h'",
    ])
    expect(sqls(my({ op: 'revokePrivileges', ...on }))).toEqual(["REVOKE SELECT, UPDATE ON `a\\_b`.* FROM 'u'@'h'"])
  })

  it('revokes the grant option alone, whole, and refuses it per column', () => {
    const on: Target = { user: u, database: 'db', privileges: ['SELECT'] }
    expect(sqls(my({ op: 'revokePrivileges', ...on, grantOption: true }))).toEqual([
      "REVOKE GRANT OPTION ON `db`.* FROM 'u'@'h'",
    ])
    expect(sqls(my({ op: 'revokePrivileges', ...on, table: 't', grantOption: true }))).toEqual([
      "REVOKE GRANT OPTION ON `db`.`t` FROM 'u'@'h'",
    ])
    refuses(
      () => my({ op: 'revokePrivileges', ...on, table: 't', columns: ['c'], grantOption: true }),
      'VALIDATION',
      /grant option per table or database, not per column/
    )
    expect(sqls(my({ op: 'revokePrivileges', ...on, table: 't', columns: ['c'], grantOption: false }))).toEqual([
      "REVOKE SELECT (`c`) ON `db`.`t` FROM 'u'@'h'",
    ])
  })

  it('works in the server namespace whatever the op', () => {
    const server = { database: 'x' }
    expect(mysqlUsers.namespace({ op: 'grantAll', user: u, database: 'db' }, server)).toBe(server)
  })
})

describe('MySQL: reading accounts', () => {
  const mysqlRow = ['bob', 'h', 'N', 'N', '', 10, 20, 30, 40]

  it('reads an account with its attributes, TLS requirement and limits', () => {
    const { conn } = scripted([
      [
        /FROM mysql\.user ORDER BY/,
        rows([
          mysqlRow,
          ['al', '%', 'Y', 'Y', 'ANY', null, null, null, null],
          ['x', '%', 'N', 'N', 'X509', 0, 0, 0, 0],
        ]),
      ],
    ])
    return mysqlListUsers(conn).then((list) => {
      expect(list[0]).toEqual({
        name: 'bob',
        host: 'h',
        canLogin: true,
        attributes: [],
        limits: { require: 'NONE', maxQueries: 10, maxUpdates: 20, maxConnections: 30, maxUserConnections: 40 },
      })
      expect(list[1]).toEqual({
        name: 'al',
        host: '%',
        canLogin: false,
        attributes: ['LOCKED', 'EXPIRED'],
        limits: { require: 'SSL', maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0 },
      })
      expect(list[2]?.limits?.require).toBe('X509')
      expect(list[2]?.attributes).toEqual([])
    })
  })

  it('reads a missing TLS requirement as none', async () => {
    const { conn } = scripted([[/FROM mysql\.user ORDER BY/, rows([['a', '%', 'N', 'N', null, 0, 0, 0, 0]])]])
    expect((await mysqlListUsers(conn))[0]?.limits?.require).toBe('NONE')
  })

  it('tells a locked account from an expired one', async () => {
    const { conn } = scripted([
      [
        /FROM mysql\.user ORDER BY/,
        rows([
          ['a', '%', 'Y', 'N', '', 0, 0, 0, 0],
          ['b', '%', 'N', 'Y', '', 0, 0, 0, 0],
        ]),
      ],
    ])
    const [a, b] = await mysqlListUsers(conn)
    expect([a?.attributes, a?.canLogin]).toEqual([['LOCKED'], false])
    expect([b?.attributes, b?.canLogin]).toEqual([['EXPIRED'], true])
  })

  it('falls back to the MariaDB form when the account_locked column is missing, and remembers it for the connection', async () => {
    const { conn, asked } = scripted([
      [/account_locked, password_expired/, fail('QUERY_FAILED', 'ER_BAD_FIELD_ERROR')],
      [/mysql\.global_priv/, rows([mysqlRow])],
    ])
    expect(await mysqlListUsers(conn)).toHaveLength(1)
    expect(asked).toHaveLength(2)
    await mysqlListUsers(conn)
    // The second read goes straight to the MariaDB form.
    expect(asked).toHaveLength(3)
    expect(asked[2]?.text).toContain('mysql.global_priv')
  })

  it('does not take any other failure for MariaDB', async () => {
    const other = scripted([[/FROM mysql\.user ORDER BY/, fail('QUERY_FAILED', 'ER_ACCESS_DENIED')]])
    await expect(mysqlListUsers(other.conn)).rejects.toMatchObject({ nativeCode: 'ER_ACCESS_DENIED' })
    const plainError = scripted([[/FROM mysql\.user ORDER BY/, new Error('boom')]])
    await expect(mysqlListUsers(plainError.conn)).rejects.toThrow('boom')
  })

  it('may manage accounts with CREATE USER, and on a server that has SYSTEM_USER only with that too', async () => {
    const answer = (privileges: (string | null)[], version: string) =>
      mysqlCanManageAccount(scripted([[/USER_PRIVILEGES/, rows(privileges.map((p) => [p, version]))]]).conn)
    expect(await answer(['CREATE USER', 'SYSTEM_USER'], '8.0.30')).toBe(true)
    expect(await answer(['CREATE USER'], '8.0.30')).toBe(false)
    expect(await answer(['SYSTEM_USER'], '8.0.30')).toBe(false)
    expect(await answer(['CREATE USER'], '10.11.5-MariaDB')).toBe(true)
    expect(await answer(['CREATE USER'], '8.0.15')).toBe(true)
    expect(await answer([null], '8.0.30')).toBe(false)
    expect(await answer([], '')).toBe(false)
  })

  it('reads the version where SYSTEM_USER begins: 8.0.16, and not for MariaDB', () => {
    expect(hasSystemUser('8.0.16')).toBe(true)
    expect(hasSystemUser('8.0.15')).toBe(false)
    expect(hasSystemUser('8.0.0')).toBe(false)
    expect(hasSystemUser('8.0.16-log')).toBe(true)
    expect(hasSystemUser('8.0.100')).toBe(true)
    expect(hasSystemUser('8.1.0')).toBe(true)
    expect(hasSystemUser('8.4.3')).toBe(true)
    expect(hasSystemUser('9.0.0')).toBe(true)
    expect(hasSystemUser('7.9.99')).toBe(false)
    expect(hasSystemUser('5.7.44')).toBe(false)
    expect(hasSystemUser('10.11.5-MariaDB')).toBe(false)
    expect(hasSystemUser('MARIADB 11')).toBe(false)
    // A version that cannot be read is taken to have it: the check asks for more, never for less.
    expect(hasSystemUser('')).toBe(true)
    expect(hasSystemUser('8.0')).toBe(true)
    expect(hasSystemUser('8')).toBe(true)
    expect(hasSystemUser('x.1.2')).toBe(true)
    expect(hasSystemUser('8.x.2')).toBe(true)
    expect(hasSystemUser('8.0.x')).toBe(true)
  })

  it("shows an account's grants without the password hashes MariaDB prints in them", async () => {
    const { conn, asked } = scripted([
      [
        /SHOW GRANTS/,
        rows([
          ["GRANT ALL PRIVILEGES ON *.* TO 'u'@'h' IDENTIFIED BY PASSWORD '*ABC123'"],
          ["GRANT USAGE ON *.* TO 'u'@'h' IDENTIFIED VIA mysql_native_password USING '*DEF456' WITH GRANT OPTION"],
          ['GRANT SELECT ON `d`.* TO `u`@`h`'],
          [null],
        ]),
      ],
    ])
    expect(await mysqlShowGrants(conn, u)).toEqual([
      "GRANT ALL PRIVILEGES ON *.* TO 'u'@'h'",
      "GRANT USAGE ON *.* TO 'u'@'h' WITH GRANT OPTION",
      'GRANT SELECT ON `d`.* TO `u`@`h`',
      '',
    ])
    expect(asked[0]?.text).toBe("SHOW GRANTS FOR 'u'@'h'")
  })
})

describe('PostgreSQL: account ops', () => {
  const role = { name: 'r' }

  it('creates a role with LOGIN and the flags asked for, masking the password in the preview', () => {
    const create = (extra: Record<string, unknown> = {}) =>
      pg({ op: 'createUser', user: role, password: 'pw', attributes: plainAttrs, ...extra } as UserOp)
    expect(create()[0]).toEqual({
      sql: `CREATE ROLE "r" LOGIN PASSWORD 'pw'`,
      display: `CREATE ROLE "r" LOGIN PASSWORD '${PASSWORD_MASK}'`,
    })
    expect(
      sqls(create({ attributes: { superuser: true, createdb: true, createrole: true }, replication: true }))
    ).toEqual([`CREATE ROLE "r" LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION PASSWORD 'pw'`])
    expect(sqls(create({ attributes: { ...plainAttrs, createdb: true } }))).toEqual([
      `CREATE ROLE "r" LOGIN CREATEDB PASSWORD 'pw'`,
    ])
    expect(sqls(create({ attributes: { ...plainAttrs, createrole: true } }))).toEqual([
      `CREATE ROLE "r" LOGIN CREATEROLE PASSWORD 'pw'`,
    ])
    expect(sqls(create({ replication: false }))).toEqual([`CREATE ROLE "r" LOGIN PASSWORD 'pw'`])
    for (const mysqlOnly of [{ plugin: 'mysql_native_password' }, { createDatabase: true }, { grantWildcard: true }]) {
      refuses(() => create(mysqlOnly), 'UNSUPPORTED', /are MySQL options/)
    }
    expect(sqls(create({ createDatabase: false, grantWildcard: false }))).toHaveLength(1)
  })

  it('drops, locks, unlocks, renames and sets the password of a role', () => {
    expect(sqls(pg({ op: 'dropUser', user: role }))).toEqual(['DROP ROLE "r"'])
    expect(sqls(pg({ op: 'lockUser', user: role, locked: true }))).toEqual(['ALTER ROLE "r" NOLOGIN'])
    expect(sqls(pg({ op: 'lockUser', user: role, locked: false }))).toEqual(['ALTER ROLE "r" LOGIN'])
    expect(sqls(pg({ op: 'renameUser', user: role, newUser: { name: 'n"x' } }))).toEqual([
      'ALTER ROLE "r" RENAME TO "n""x"',
    ])
    expect(pg({ op: 'setPassword', user: role, password: 'pw' })).toEqual([
      { sql: `ALTER ROLE "r" PASSWORD 'pw'`, display: `ALTER ROLE "r" PASSWORD '${PASSWORD_MASK}'` },
    ])
  })

  it('drops roles after giving their objects away and dropping their grants, and has no same-named databases', () => {
    const users = [{ name: 'a' }, { name: 'b' }]
    expect(sqls(pg({ op: 'dropUsers', users }))).toEqual(['DROP ROLE "a", "b"'])
    expect(sqls(pg({ op: 'dropUsers', users, revokeFirst: true }))).toEqual([
      'REASSIGN OWNED BY "a" TO CURRENT_USER',
      'DROP OWNED BY "a"',
      'REASSIGN OWNED BY "b" TO CURRENT_USER',
      'DROP OWNED BY "b"',
      'DROP ROLE "a", "b"',
    ])
    expect(sqls(pg({ op: 'dropUsers', users, revokeFirst: false, dropSameNameDatabases: false }))).toHaveLength(1)
    refuses(
      () => pg({ op: 'dropUsers', users, dropSameNameDatabases: true }),
      'UNSUPPORTED',
      /same-named database is MySQL/
    )
  })

  it('copies a role: a new login role, then the grants with the role name swapped for the new one', () => {
    const grants = [
      'ALTER ROLE "r" NOSUPERUSER LOGIN',
      'ALTER ROLE "rx" NOSUPERUSER',
      'GRANT SELECT ON "s"."t" TO "r"',
      'GRANT "grp" TO "r"',
      'GRANT SELECT ON "s"."t" TO "other"',
      'GRANT USAGE ON SCHEMA "s" TO "r" WITH GRANT OPTION',
    ]
    const out = pg({ op: 'copyUser', user: role, newUser: { name: 'n' }, password: 'pw', grants })
    expect(out[0]?.display).toBe(`CREATE ROLE "n" LOGIN PASSWORD '${PASSWORD_MASK}'`)
    expect(sqls(out).slice(1)).toEqual([
      'ALTER ROLE "n" NOSUPERUSER LOGIN',
      'ALTER ROLE "rx" NOSUPERUSER',
      'GRANT SELECT ON "s"."t" TO "n"',
      'GRANT "grp" TO "n"',
      'GRANT SELECT ON "s"."t" TO "other"',
      'GRANT USAGE ON SCHEMA "s" TO "r" WITH GRANT OPTION',
    ])
    refuses(
      () => pg({ op: 'copyUser', user: role, newUser: { name: 'n' }, password: 'pw' }),
      'VALIDATION',
      /needs the grants of the role/
    )
  })

  it('limits only the simultaneous connections, 0 meaning no limit', () => {
    expect(sqls(pg({ op: 'setAccountLimits', user: role, maxUserConnections: 5 }))).toEqual([
      'ALTER ROLE "r" CONNECTION LIMIT 5',
    ])
    expect(sqls(pg({ op: 'setAccountLimits', user: role, maxUserConnections: 0 }))).toEqual([
      'ALTER ROLE "r" CONNECTION LIMIT -1',
    ])
    refuses(() => pg({ op: 'setAccountLimits', user: role }), 'VALIDATION', /No account limit to change/)
    for (const other of [
      { require: 'SSL' },
      { maxQueries: 1 },
      { maxUpdates: 1 },
      { maxConnections: 1 },
      { maxQueries: 0 },
    ]) {
      refuses(
        () => pg({ op: 'setAccountLimits', user: role, maxUserConnections: 1, ...other } as UserOp),
        'UNSUPPORTED',
        /limits only the simultaneous connections/
      )
    }
    refuses(
      () => pg({ op: 'changeGlobalPrivileges', user: role, grant: ['SELECT'], revoke: [] }),
      'UNSUPPORTED',
      /Global privileges are MySQL/
    )
  })

  it('alters the role attributes given, each as on or off, and refuses a change of nothing', () => {
    expect(
      sqls(
        pg({
          op: 'alterRole',
          user: role,
          superuser: true,
          createdb: true,
          createrole: true,
          replication: true,
          bypassrls: true,
          inherit: true,
          login: true,
        })
      )
    ).toEqual(['ALTER ROLE "r" SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS INHERIT LOGIN'])
    expect(
      sqls(
        pg({
          op: 'alterRole',
          user: role,
          superuser: false,
          createdb: false,
          createrole: false,
          replication: false,
          bypassrls: false,
          inherit: false,
          login: false,
        })
      )
    ).toEqual(['ALTER ROLE "r" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT NOLOGIN'])
    expect(sqls(pg({ op: 'alterRole', user: role, bypassrls: true }))).toEqual(['ALTER ROLE "r" BYPASSRLS'])
    expect(sqls(pg({ op: 'alterRole', user: role, inherit: false }))).toEqual(['ALTER ROLE "r" NOINHERIT'])
    refuses(() => pg({ op: 'alterRole', user: role }), 'VALIDATION', /No role attribute to change/)
  })

  it('grants and revokes EXECUTE on a routine, in its schema, and refuses the MySQL privileges', () => {
    const on: RoutineTarget = { user: role, database: 'db', routine: 'f', kind: 'FUNCTION', privileges: ['EXECUTE'] }
    expect(sqls(pg({ op: 'grantRoutinePrivileges', ...on }))).toEqual([
      'GRANT EXECUTE ON FUNCTION "public"."f"() TO "r"',
    ])
    expect(sqls(pg({ op: 'revokeRoutinePrivileges', ...on, schema: 's', parameters: 'int, text' }))).toEqual([
      'REVOKE EXECUTE ON FUNCTION "s"."f"(int, text) FROM "r"',
    ])
    refuses(
      () => pg({ op: 'grantRoutinePrivileges', ...on, privileges: ['EXECUTE', 'ALTER ROUTINE'] }),
      'UNSUPPORTED',
      /EXECUTE on a routine/
    )
    refuses(
      () => pg({ op: 'revokeRoutinePrivileges', ...on, privileges: ['GRANT OPTION'] }),
      'UNSUPPORTED',
      /EXECUTE on a routine/
    )
  })

  it('works in the database and schema a privilege op names, else the server namespace', () => {
    const server = { database: 'x', schema: 'y' }
    for (const op of ['grantAll', 'revokeAll'] as const)
      expect(pgUsers.namespace({ op, user: role, database: 'db', schema: 's' }, server)).toEqual({
        database: 'db',
        schema: 's',
      })
    expect(pgUsers.namespace({ op: 'grantAll', user: role, database: 'db' }, server)).toEqual({ database: 'db' })
    const priv: Target = { user: role, database: 'db', privileges: ['SELECT'] }
    expect(pgUsers.namespace({ op: 'grantPrivileges', ...priv, schema: 's' }, server)).toEqual({
      database: 'db',
      schema: 's',
    })
    expect(pgUsers.namespace({ op: 'revokePrivileges', ...priv }, server)).toEqual({ database: 'db' })
    const routine: RoutineTarget = {
      user: role,
      database: 'db',
      routine: 'f',
      kind: 'FUNCTION',
      privileges: ['EXECUTE'],
    }
    expect(pgUsers.namespace({ op: 'grantRoutinePrivileges', ...routine, schema: 's' }, server)).toEqual({
      database: 'db',
      schema: 's',
    })
    expect(pgUsers.namespace({ op: 'revokeRoutinePrivileges', ...routine }, server)).toEqual({ database: 'db' })
    expect(pgUsers.namespace({ op: 'dropUser', user: role }, server)).toBe(server)
    expect(pgUsers.namespace({ op: 'setPassword', user: role, password: 'p' }, server)).toBe(server)
  })

  it('grants everything on a schema with the default privileges, in the public schema when none is named', () => {
    expect(sqls(pg({ op: 'grantAll', user: role, database: 'db', schema: 's' }))).toEqual([
      'GRANT CONNECT, TEMP ON DATABASE "db" TO "r"',
      'GRANT USAGE, CREATE ON SCHEMA "s" TO "r"',
      'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "s" TO "r"',
      'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "s" TO "r"',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "s" GRANT ALL PRIVILEGES ON TABLES TO "r"',
    ])
    expect(sqls(pg({ op: 'grantAll', user: role, database: 'db' }))[1]).toBe(
      'GRANT USAGE, CREATE ON SCHEMA "public" TO "r"'
    )
    expect(sqls(pg({ op: 'revokeAll', user: role, database: 'db', schema: 's' }))).toEqual([
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "s" REVOKE ALL PRIVILEGES ON TABLES FROM "r"',
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "s" FROM "r"',
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "s" FROM "r"',
      'REVOKE ALL PRIVILEGES ON SCHEMA "s" FROM "r"',
      'REVOKE ALL PRIVILEGES ON DATABASE "db" FROM "r"',
    ])
    expect(sqls(pg({ op: 'revokeAll', user: role, database: 'db' }))[0]).toContain('IN SCHEMA "public"')
  })

  it('grants on a table with CONNECT and USAGE implied, or on every table with the default privileges', () => {
    const on: Target = { user: role, database: 'db', privileges: ['SELECT', 'UPDATE'] }
    expect(sqls(pg({ op: 'grantPrivileges', ...on, schema: 's', table: 't', grantOption: true }))).toEqual([
      'GRANT CONNECT ON DATABASE "db" TO "r"',
      'GRANT USAGE ON SCHEMA "s" TO "r"',
      'GRANT SELECT, UPDATE ON "s"."t" TO "r" WITH GRANT OPTION',
    ])
    expect(sqls(pg({ op: 'grantPrivileges', ...on }))).toEqual([
      'GRANT CONNECT ON DATABASE "db" TO "r"',
      'GRANT USAGE ON SCHEMA "public" TO "r"',
      'GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "public" TO "r"',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT, UPDATE ON TABLES TO "r"',
    ])
    expect(sqls(pg({ op: 'grantPrivileges', ...on, schema: 's', grantOption: true })).slice(2)).toEqual([
      'GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "s" TO "r" WITH GRANT OPTION',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "s" GRANT SELECT, UPDATE ON TABLES TO "r" WITH GRANT OPTION',
    ])
    expect(sqls(pg({ op: 'grantPrivileges', ...on, table: 't', columns: ['c'], grantOption: false }))[2]).toBe(
      'GRANT SELECT ("c"), UPDATE ("c") ON "public"."t" TO "r"'
    )
  })

  it('revokes from a table, or from every table and the default privileges, optionally the grant option only', () => {
    const on: Target = { user: role, database: 'db', privileges: ['SELECT'] }
    expect(sqls(pg({ op: 'revokePrivileges', ...on, schema: 's', table: 't' }))).toEqual([
      'REVOKE SELECT ON "s"."t" FROM "r"',
    ])
    expect(sqls(pg({ op: 'revokePrivileges', ...on, table: 't', grantOption: true }))).toEqual([
      'REVOKE GRANT OPTION FOR SELECT ON "public"."t" FROM "r"',
    ])
    expect(sqls(pg({ op: 'revokePrivileges', ...on, schema: 's' }))).toEqual([
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "s" REVOKE SELECT ON TABLES FROM "r"',
      'REVOKE SELECT ON ALL TABLES IN SCHEMA "s" FROM "r"',
    ])
    expect(sqls(pg({ op: 'revokePrivileges', ...on, grantOption: true }))).toEqual([
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE GRANT OPTION FOR SELECT ON TABLES FROM "r"',
      'REVOKE GRANT OPTION FOR SELECT ON ALL TABLES IN SCHEMA "public" FROM "r"',
    ])
  })
})

describe('PostgreSQL: reading roles', () => {
  it('reads the attributes of a role, leaving out those at their default', () => {
    const { conn } = scripted([
      [
        /FROM pg_roles WHERE rolname NOT LIKE/,
        rows([
          ['plain', false, false, false, true, null, -1, false, false, true],
          ['all', true, true, true, false, '2030-01-01', 5, true, true, false],
          ['forever', false, false, false, true, 'infinity', 0, false, false, true],
          ['unknown', null, null, null, null, undefined, null, null, null, null],
        ]),
      ],
    ])
    return pgListUsers(conn).then((list) => {
      expect(list[0]).toEqual({
        name: 'plain',
        host: null,
        canLogin: true,
        attributes: [],
        limits: { require: 'NONE', maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0 },
      })
      expect(list[1]?.attributes).toEqual([
        'SUPERUSER',
        'CREATEROLE',
        'CREATEDB',
        'REPLICATION',
        'BYPASSRLS',
        'NOINHERIT',
        'NOLOGIN',
        'VALID UNTIL 2030-01-01',
      ])
      expect(list[1]?.canLogin).toBe(false)
      expect(list[1]?.limits?.maxUserConnections).toBe(5)
      expect(list[2]?.attributes).toEqual([])
      expect(list[2]?.limits?.maxUserConnections).toBe(0)
      expect(list[3]?.attributes).toEqual(['NOINHERIT', 'NOLOGIN'])
      expect(list[3]?.canLogin).toBe(false)
      expect(list[3]?.limits?.maxUserConnections).toBe(0)
    })
  })

  it('may manage a role only when the server answers true', async () => {
    const answer = async (value: unknown, none = false) => {
      const { conn, asked } = scripted([[/FROM pg_roles me/, rows(none ? [] : [[value]])]])
      const result = await pgCanManageAccount(conn, 'target')
      expect(asked[0]?.params).toEqual(['target'])
      return result
    }
    expect(await answer(true)).toBe(true)
    expect(await answer(false)).toBe(false)
    expect(await answer(null)).toBe(false)
    expect(await answer('t')).toBe(false)
    expect(await answer(undefined, true)).toBe(false)
  })

  describe('showing grants', () => {
    const script = (over: Partial<Record<'role' | 'members' | 'schemas' | 'tables' | 'columns', unknown[][]>> = {}) =>
      scripted([
        [/has_database_privilege/, rows(over.role ?? [[false, false, false, true, true, 'db', false, false]])],
        [/pg_auth_members/, rows(over.members ?? [])],
        [/has_schema_privilege/, rows(over.schemas ?? [])],
        [/string_agg/, rows(over.tables ?? [])],
        [/attacl IS NOT NULL/, rows(over.columns ?? [])],
      ])

    it('asks every query about the role by name', async () => {
      const { conn, asked } = script({ columns: [['s', 't', 'SELECT', 'a']] })
      await pgShowGrants(conn, { name: 'r' })
      expect(asked).toHaveLength(5)
      for (const q of asked) expect(q.params).toEqual(['r'])
    })

    it('gives nothing for a role that does not exist', async () => {
      const { conn } = script({ role: [] })
      expect(await pgShowGrants(conn, { name: 'r' })).toEqual([])
    })

    it("reads the role's flags, only the ones that are on for REPLICATION, and asks about the role by name", async () => {
      const off = script()
      expect(await pgShowGrants(off.conn, { name: 'r' })).toEqual([
        'ALTER ROLE "r" NOSUPERUSER NOCREATEROLE NOCREATEDB LOGIN INHERIT',
      ])
      expect(off.asked[0]?.params).toEqual(['r'])
      const on = script({ role: [[true, true, true, false, false, 'db', false, true]] })
      expect(await pgShowGrants(on.conn, { name: 'r' })).toEqual([
        'ALTER ROLE "r" SUPERUSER CREATEROLE CREATEDB NOLOGIN NOINHERIT REPLICATION',
      ])
    })

    it('lists memberships, database CREATE, schemas, tables and their grant option', async () => {
      const { conn } = script({
        role: [[false, false, false, true, true, 'my"db', true, false]],
        members: [['grp'], ['grp2']],
        schemas: [['s1']],
        tables: [
          ['s', 't', 'SELECT, UPDATE', false],
          ['s', 'u', 'SELECT', true],
        ],
      })
      expect(await pgShowGrants(conn, { name: 'r' })).toEqual([
        'ALTER ROLE "r" NOSUPERUSER NOCREATEROLE NOCREATEDB LOGIN INHERIT',
        'GRANT "grp" TO "r"',
        'GRANT "grp2" TO "r"',
        'GRANT CREATE ON DATABASE "my""db" TO "r"',
        'GRANT USAGE ON SCHEMA "s1" TO "r"',
        'GRANT SELECT, UPDATE ON "s"."t" TO "r"',
        'GRANT SELECT ON "s"."u" TO "r" WITH GRANT OPTION',
      ])
    })

    it('joins the columns of one privilege on one table into one grant, and starts a new one when either changes', async () => {
      const { conn } = script({
        columns: [
          ['s', 't', 'SELECT', 'a'],
          ['s', 't', 'SELECT', 'b'],
          ['s', 't', 'UPDATE', 'a'],
          ['s', 'u', 'UPDATE', 'a'],
          ['x', 'u', 'UPDATE', 'c'],
        ],
      })
      expect((await pgShowGrants(conn, { name: 'r' })).slice(1)).toEqual([
        'GRANT SELECT ("a", "b") ON "s"."t" TO "r"',
        'GRANT UPDATE ("a") ON "s"."t" TO "r"',
        'GRANT UPDATE ("a") ON "s"."u" TO "r"',
        'GRANT UPDATE ("c") ON "x"."u" TO "r"',
      ])
    })
  })
})
