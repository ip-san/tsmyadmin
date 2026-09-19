import { describe, expect, it } from 'vitest'
import { groupTabOf, UserGroupBodySchema } from './user-groups.ts'

describe('user groups', () => {
  it('names the tab a route path stands for, at each level', () => {
    expect(groupTabOf('/sql')).toBe('server:sql')
    expect(groupTabOf('/db/$db/export')).toBe('db:export')
    expect(groupTabOf('/db/$db/table/$table/operations')).toBe('table:operations')
  })

  it('never hides a landing tab or the security tab', () => {
    expect(groupTabOf('/')).toBeNull()
    expect(groupTabOf('/db/$db')).toBeNull()
    expect(groupTabOf('/db/$db/table/$table')).toBeNull()
    expect(groupTabOf('/security')).toBeNull()
  })

  it('accepts only known tabs and at least one member', () => {
    const ok = { name: 'readers', members: ['alice'], hiddenTabs: ['server:sql', 'table:operations'] }
    expect(UserGroupBodySchema.safeParse(ok).success).toBe(true)
    expect(UserGroupBodySchema.safeParse({ ...ok, hiddenTabs: ['server:security'] }).success).toBe(false)
    expect(UserGroupBodySchema.safeParse({ ...ok, members: [] }).success).toBe(false)
  })
})
