import { describe, expect, it } from 'vitest'
import { privilegeLevel } from './privilege-level.ts'

describe('privilegeLevel', () => {
  it('reads MySQL grants for one database', () => {
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`'])).toBe('all')
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT ALL PRIVILEGES ON `shop`.* TO `app`@`%`'])).toBe('all')
    expect(privilegeLevel('mysql', 'shop', undefined, ['GRANT SELECT ON `shop`.`users` TO `ro`@`%`'])).toBe('some')
    expect(
      privilegeLevel('mysql', 'shop', undefined, ['GRANT USAGE ON *.* TO `x`@`%`', 'GRANT ALL ON `other`.* TO `x`@`%`'])
    ).toBe('none')
    expect(privilegeLevel('mysql', 'a.b', undefined, ['GRANT SELECT ON `a.b`.* TO `x`@`%`'])).toBe('some')
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
})
