import { describe, expect, it } from 'vitest'
import { type DatabaseGrant, databaseGrants, grantDatabase, revokeOp, splitPrivileges } from './database-grants.ts'

describe('databaseGrants (MySQL)', () => {
  const statements = [
    'GRANT USAGE ON *.* TO `u`@`%`',
    'GRANT PROCESS, RELOAD ON *.* TO `u`@`%`',
    'GRANT SELECT, INSERT ON `shop`.* TO `u`@`%`',
    'GRANT ALL PRIVILEGES ON `sales\\_%`.* TO `u`@`%` WITH GRANT OPTION',
    'GRANT SELECT (`a`, `b`), UPDATE (`a`) ON `shop`.`orders` TO `u`@`%`',
    'GRANT EXECUTE ON PROCEDURE `shop`.`do_it` TO `u`@`%`',
    'GRANT DELETE ON TABLE `we``ird`.`t` TO `u`@`%`',
  ]

  it('lists what is held on databases, tables and routines, and leaves the server-wide grants out', () => {
    const grants = databaseGrants('mysql', statements)
    expect(grants.map((g) => [g.kind, g.database, g.object, g.privileges, g.grantOption])).toEqual([
      ['database', 'shop', null, ['SELECT', 'INSERT'], false],
      ['database', 'sales\\_%', null, ['ALL PRIVILEGES'], true],
      ['table', 'shop', 'orders', ['SELECT (`a`, `b`)', 'UPDATE (`a`)'], false],
      ['routine', 'shop', 'do_it', ['EXECUTE'], false],
      ['table', 'we`ird', 't', ['DELETE'], false],
    ])
  })
})

describe('databaseGrants (PostgreSQL)', () => {
  it('reads schema and table grants, and skips role membership and the database-level CREATE', () => {
    const grants = databaseGrants('postgres', [
      'ALTER ROLE "u" NOSUPERUSER LOGIN',
      'GRANT "readers" TO "u"',
      'GRANT CREATE ON DATABASE "shop" TO "u"',
      'GRANT USAGE ON SCHEMA "app" TO "u"',
      'GRANT INSERT, SELECT ON "app"."o""rders" TO "u"',
    ])
    expect(grants.map((g) => [g.kind, g.schema, g.object, g.privileges])).toEqual([
      ['schema', 'app', null, ['USAGE']],
      ['table', 'app', 'o"rders', ['INSERT', 'SELECT']],
    ])
  })
})

describe('splitPrivileges', () => {
  it('keeps a column list together', () => {
    expect(splitPrivileges('SELECT (a, b), INSERT, UPDATE (c)')).toEqual(['SELECT (a, b)', 'INSERT', 'UPDATE (c)'])
  })
})

describe('grantDatabase and literalDatabase', () => {
  it('reads an escaped name as one database and a bare wildcard as a pattern, but takes table grants literally', () => {
    const [pattern, escaped, table] = databaseGrants('mysql', [
      'GRANT SELECT ON `sales_%`.* TO `u`@`%`',
      'GRANT SELECT ON `shop\\_1`.* TO `u`@`%`',
      'GRANT SELECT ON `shop_1`.`t` TO `u`@`%`',
    ]) as DatabaseGrant[]
    expect(grantDatabase(pattern as DatabaseGrant)).toBeNull()
    expect(grantDatabase(escaped as DatabaseGrant)).toBe('shop_1')
    expect(grantDatabase(table as DatabaseGrant)).toBe('shop_1')
  })
})

describe('revokeOp', () => {
  const user = { name: 'u', host: '%' }
  const [database, table, columns, routine] = databaseGrants('mysql', [
    'GRANT SELECT ON `shop\\_1`.* TO `u`@`%`',
    'GRANT SELECT, INSERT ON `shop_1`.`orders` TO `u`@`%`',
    'GRANT SELECT (`a`) ON `shop_1`.`orders` TO `u`@`%`',
    'GRANT EXECUTE ON PROCEDURE `shop_1`.`p` TO `u`@`%`',
  ]) as DatabaseGrant[]

  it('takes a database-wide grant away with revokeAll and a table grant with revokePrivileges', () => {
    expect(revokeOp(user, 'mysql', database as DatabaseGrant, '')).toEqual({
      op: 'revokeAll',
      user,
      database: 'shop_1',
    })
    expect(revokeOp(user, 'mysql', table as DatabaseGrant, '')).toEqual({
      op: 'revokePrivileges',
      user,
      privileges: ['SELECT', 'INSERT'],
      database: 'shop_1',
      table: 'orders',
    })
  })

  it('offers nothing for column lists, routines and patterns', () => {
    expect(revokeOp(user, 'mysql', columns as DatabaseGrant, '')).toBeNull()
    expect(revokeOp(user, 'mysql', routine as DatabaseGrant, '')).toBeNull()
    const [pattern] = databaseGrants('mysql', ['GRANT SELECT ON `sales_%`.* TO `u`@`%`']) as DatabaseGrant[]
    expect(revokeOp(user, 'mysql', pattern as DatabaseGrant, '')).toBeNull()
  })

  it('revokes a PostgreSQL schema grant in the connected database', () => {
    const [schema] = databaseGrants('postgres', ['GRANT USAGE ON SCHEMA "app" TO "u"']) as DatabaseGrant[]
    expect(revokeOp({ name: 'u' }, 'postgres', schema as DatabaseGrant, 'shop')).toEqual({
      op: 'revokeAll',
      user: { name: 'u' },
      database: 'shop',
      schema: 'app',
    })
  })
})
