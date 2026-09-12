import { describe, expect, it } from 'vitest'
import { COLUMN_PRIVILEGES, columnTargetError, PRIVILEGES, UserOpRequestSchema } from './users.ts'

const base = { user: { name: 'reader' }, database: 'shop', table: 'orders' }
const parse = (op: unknown) => UserOpRequestSchema.safeParse({ op })

describe('column-level privilege targets', () => {
  it('only lists the privileges that have a column form', () => {
    expect(COLUMN_PRIVILEGES).toEqual(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'])
    // DELETE and TRIGGER act on the whole table on both servers.
    expect(PRIVILEGES.filter((p) => !COLUMN_PRIVILEGES.includes(p as never))).toEqual(['DELETE', 'TRIGGER'])
  })

  it('accepts columns on one table', () => {
    expect(parse({ op: 'grantPrivileges', ...base, privileges: ['SELECT'], columns: ['name'] }).success).toBe(true)
    expect(parse({ op: 'revokePrivileges', ...base, privileges: ['UPDATE'], columns: ['name', 'note'] }).success).toBe(
      true
    )
  })

  it('refuses columns without a table, before the SQL is ever previewed', () => {
    const { table: _table, ...noTable } = base
    const bad = parse({ op: 'grantPrivileges', ...noTable, privileges: ['SELECT'], columns: ['name'] })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(['op', 'columns'])
  })

  it('refuses a privilege that has no column form', () => {
    expect(parse({ op: 'grantPrivileges', ...base, privileges: ['DELETE'], columns: ['name'] }).success).toBe(false)
    expect(
      parse({ op: 'grantPrivileges', ...base, privileges: ['SELECT', 'TRIGGER'], columns: ['name'] }).success
    ).toBe(false)
    // Without columns those privileges are perfectly valid.
    expect(parse({ op: 'grantPrivileges', ...base, privileges: ['DELETE', 'TRIGGER'] }).success).toBe(true)
  })

  it('refuses an empty column list rather than treating it as "the whole table"', () => {
    expect(parse({ op: 'grantPrivileges', ...base, privileges: ['SELECT'], columns: [] }).success).toBe(false)
  })

  it('leaves the other operations alone', () => {
    expect(parse({ op: 'dropUser', user: { name: 'reader' } }).success).toBe(true)
    expect(parse({ op: 'grantAll', user: { name: 'reader' }, database: 'shop' }).success).toBe(true)
  })

  it('names the reason, for the form to show before submitting', () => {
    expect(columnTargetError({ privileges: ['SELECT'], table: 'orders', columns: ['name'] })).toBeNull()
    expect(columnTargetError({ privileges: ['SELECT'], columns: ['name'] })).toBe('needsTable')
    expect(columnTargetError({ privileges: ['DELETE'], table: 'orders', columns: ['name'] })).toBe('notColumnPrivilege')
    // No columns at all is not a column grant, so there is nothing to complain about.
    expect(columnTargetError({ privileges: ['DELETE'] })).toBeNull()
  })
})
