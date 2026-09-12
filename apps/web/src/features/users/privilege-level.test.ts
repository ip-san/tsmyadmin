import { describe, expect, it } from 'vitest'
import { globalPrivilegeLevel, privilegeLevel } from './privilege-level.ts'

describe('privilegeLevel', () => {
  it('reads MySQL grants for one database', () => {
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`'])).toBe('all')
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT ALL PRIVILEGES ON `shop`.* TO `app`@`%`'])).toBe('all')
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT SELECT ON `shop`.`users` TO `ro`@`%`'])).toBe('some')
    expect(
      privilegeLevel('mysql', 'shop', undefined, ['GRANT USAGE ON *.* TO `x`@`%`', 'GRANT ALL ON `other`.* TO `x`@`%`'])
    ).toBe('none')
    expect(privilegeLevel('mysql', 'a.b', undefined, ['GRANT SELECT ON `a.b`.* TO `x`@`%`'])).toBe('some')
    // MySQL 8.4 prints the explicit list instead of ALL PRIVILEGES for root and for accounts created with it.
    const explicit =
      'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, RELOAD, SHUTDOWN, PROCESS, FILE, REFERENCES, INDEX, ALTER, SHOW DATABASES, SUPER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, REPLICATION SLAVE, REPLICATION CLIENT, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, CREATE USER, EVENT, TRIGGER, CREATE TABLESPACE, CREATE ROLE, DROP ROLE ON *.* TO `root`@`%` WITH GRANT OPTION'
    expect(privilegeLevel('mysql', 'shop', undefined, [explicit])).toBe('all')
    expect(globalPrivilegeLevel([explicit])).toBe('all')
    expect(globalPrivilegeLevel(['GRANT SELECT ON *.* TO `ro`@`%`'])).toBe('some')
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT SELECT ON *.* TO `ro`@`%`'])).toBe('some')
    expect(globalPrivilegeLevel(['GRANT USAGE ON *.* TO `x`@`%`'])).toBeNull()
    expect(privilegeLevel('mysql', 'my_db', undefined, ['GRANT ALL PRIVILEGES ON `my\\_db`.* TO `x`@`%`'])).toBe('all')
    expect(privilegeLevel('mysql', 'my_db', undefined, ['GRANT SELECT ON `my_db`.`t` TO `x`@`%`'])).toBe('some')
  })

  it('reads PostgreSQL grants for one database / schema', () => {
    expect(privilegeLevel('postgres', 'app', 'public', ['ALTER ROLE "admin" SUPERUSER CREATEROLE'])).toBe('all')
    expect(privilegeLevel('postgres', 'app', 'public', ['GRANT USAGE ON SCHEMA "public" TO "r"'])).toBe('some')
    expect(privilegeLevel('postgres', 'app', 'sales', ['GRANT SELECT ON "sales"."orders" TO "r"'])).toBe('some')
    expect(
      privilegeLevel('postgres', 'app', 'sales', ['GRANT DELETE, INSERT, SELECT, UPDATE ON "sales"."orders" TO "r"'])
    ).toBe('all')
    expect(privilegeLevel('postgres', 'app', 'sales', ['GRANT SELECT ON "public"."orders" TO "r"'])).toBe('none')
    expect(privilegeLevel('postgres', 'app', undefined, ['ALTER ROLE "r" NOSUPERUSER LOGIN'])).toBe('none')
  })

  it('treats a column grant as partial, never as everything', () => {
    // The narrowest grant there is: one privilege, on one column, of one table.
    const pg = ['GRANT USAGE ON SCHEMA "public" TO "r"', 'GRANT UPDATE (name) ON "public"."users" TO "r"']
    expect(privilegeLevel('postgres', 'shop', 'public', pg)).toBe('some')
    // The same privilege on the whole table is what grant-all produces, and still reads as all.
    expect(privilegeLevel('postgres', 'shop', 'public', ['GRANT UPDATE ON "public"."users" TO "r"'])).toBe('all')
    // MySQL prints the same parenthesised form; it was already partial there.
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT SELECT (`name`) ON `shop`.`users` TO `r`@`%`'])).toBe(
      'some'
    )
  })
})
