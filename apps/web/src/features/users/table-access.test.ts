import { describe, expect, it } from 'vitest'
import { parseGrant, tableAccess } from './table-access.ts'

describe('parseGrant', () => {
  it('reads privileges, column lists and the object, with any character in the names', () => {
    expect(parseGrant('mysql', 'GRANT SELECT (`a`, `on, b``c`), INSERT ON `shop`.`or ders` TO `u`@`%`')).toEqual({
      privileges: [
        { name: 'SELECT', columns: ['a', 'on, b`c'] },
        { name: 'INSERT', columns: null },
      ],
      object: ['shop', 'or ders'],
    })
    expect(parseGrant('postgres', 'GRANT UPDATE ("x ON y", "q""") ON "public"."t" TO "r"')).toEqual({
      privileges: [{ name: 'UPDATE', columns: ['x ON y', 'q"'] }],
      object: ['public', 't'],
    })
    expect(parseGrant('mysql', 'GRANT CREATE TEMPORARY TABLES, LOCK TABLES ON *.* TO `u`@`%`')?.object).toEqual([
      '*',
      '*',
    ])
  })

  it('ignores statements that grant nothing on a table', () => {
    expect(parseGrant('postgres', 'GRANT USAGE ON SCHEMA "public" TO "r"')).toBeNull()
    expect(parseGrant('postgres', 'GRANT CREATE ON DATABASE "app" TO "r"')).toBeNull()
    expect(parseGrant('postgres', 'GRANT "readers" TO "r"')).toBeNull()
    expect(parseGrant('mysql', "GRANT PROXY ON ''@'' TO `root`@`localhost` WITH GRANT OPTION")).toBeNull()
    expect(parseGrant('mysql', 'GRANT `role`@`%` TO `u`@`%`')).toBeNull()
  })
})

describe('tableAccess', () => {
  it('says where each MySQL privilege on the table comes from', () => {
    const access = tableAccess('mysql', 'my_db', undefined, 'users', [
      'GRANT SELECT ON *.* TO `u`@`%`',
      'GRANT INSERT ON `my\\_db`.* TO `u`@`%`',
      'GRANT DELETE ON `my%`.* TO `u`@`%`',
      'GRANT UPDATE (`name`, `email`), REFERENCES ON `my_db`.`users` TO `u`@`%`',
      // Another table, another database, and a pattern that does not cover this one.
      'GRANT TRIGGER ON `my_db`.`posts` TO `u`@`%`',
      'GRANT TRIGGER ON `other`.`users` TO `u`@`%`',
      'GRANT TRIGGER ON `myXdb`.* TO `u`@`%`',
    ])
    expect(access).toEqual({
      SELECT: [{ scope: 'server' }],
      INSERT: [{ scope: 'database' }],
      UPDATE: [{ scope: 'columns', columns: ['name', 'email'] }],
      DELETE: [{ scope: 'database' }],
      REFERENCES: [{ scope: 'table' }],
      TRIGGER: [],
    })
  })

  it('expands ALL PRIVILEGES, and an escaped wildcard matches only itself', () => {
    const access = tableAccess('mysql', 'myXdb', undefined, 't', ['GRANT ALL PRIVILEGES ON `my\\_db`.* TO `u`@`%`'])
    expect(access.SELECT).toEqual([])
    const all = tableAccess('mysql', 'shop', undefined, 't', ['GRANT ALL PRIVILEGES ON `shop`.`t` TO `u`@`%`'])
    expect(Object.values(all).every((grants) => grants.length === 1)).toBe(true)
  })

  it('reads PostgreSQL grants in the table’s schema, and a superuser has everything', () => {
    const access = tableAccess('postgres', 'app', undefined, 'orders', [
      'GRANT DELETE, INSERT, SELECT ON "public"."orders" TO "r"',
      'GRANT UPDATE ("status") ON "public"."orders" TO "r"',
      'GRANT TRIGGER ON "sales"."orders" TO "r"',
    ])
    expect(access.SELECT).toEqual([{ scope: 'table' }])
    expect(access.UPDATE).toEqual([{ scope: 'columns', columns: ['status'] }])
    expect(access.TRIGGER).toEqual([])
    const superuser = tableAccess('postgres', 'app', 'sales', 'orders', ['ALTER ROLE "admin" SUPERUSER LOGIN'])
    expect(superuser.TRIGGER).toEqual([{ scope: 'server' }])
    expect(tableAccess('postgres', 'app', 'sales', 'orders', ['ALTER ROLE "r" NOSUPERUSER']).SELECT).toEqual([])
  })
})
