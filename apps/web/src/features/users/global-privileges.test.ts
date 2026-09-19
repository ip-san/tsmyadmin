import { describe, expect, it } from 'vitest'
import { globalPrivilegeChange, heldGlobalPrivileges } from './global-privileges.ts'

describe('heldGlobalPrivileges', () => {
  it('reads the *.* grants, ALL PRIVILEGES and WITH GRANT OPTION, and ignores the rest', () => {
    const held = heldGlobalPrivileges([
      'GRANT SELECT, PROCESS, `BINLOG_ADMIN` ON *.* TO `u`@`%` WITH GRANT OPTION',
      'GRANT ALL PRIVILEGES ON `shop`.* TO `u`@`%`',
    ])
    expect([...held].sort()).toEqual(['GRANT OPTION', 'PROCESS', 'SELECT'])
    expect(heldGlobalPrivileges(["GRANT ALL PRIVILEGES ON *.* TO 'u'@'%'"]).has('SUPER')).toBe(true)
    expect(heldGlobalPrivileges(["GRANT ALL PRIVILEGES ON *.* TO 'u'@'%'"]).has('GRANT OPTION')).toBe(false)
    expect(heldGlobalPrivileges(["GRANT USAGE ON *.* TO 'u'@'%'"]).size).toBe(0)
  })
})

describe('globalPrivilegeChange', () => {
  it('lists what to grant and what to revoke, in the screen’s order', () => {
    expect(globalPrivilegeChange(new Set(['SELECT', 'FILE']), new Set(['SELECT', 'PROCESS', 'RELOAD']))).toEqual({
      grant: ['RELOAD', 'PROCESS'],
      revoke: ['FILE'],
    })
  })
})
