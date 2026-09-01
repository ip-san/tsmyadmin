import type { UserOp } from '@tsmyadmin/shared'
import { USER_OP_NAMES } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlUsers } from '../mysql/users.ts'
import { pgUsers } from '../postgres/users.ts'

const user = { name: "o'brien", host: '10.0.%' }
const SAMPLE_OPS: Record<UserOp['op'], UserOp> = {
  createUser: {
    op: 'createUser',
    user,
    password: "p'w\\d",
    attributes: { superuser: false, createdb: true, createrole: true },
  },
  dropUser: { op: 'dropUser', user },
  setPassword: { op: 'setPassword', user, password: 'new' },
  grantAll: { op: 'grantAll', user, database: 'shop', schema: 'app' },
  revokeAll: { op: 'revokeAll', user, database: 'shop', schema: 'app' },
}

describe('user SQL builders', () => {
  it('has a sample for every UserOp', () => {
    expect(Object.keys(SAMPLE_OPS).sort()).toEqual([...USER_OP_NAMES].sort())
  })

  for (const name of USER_OP_NAMES) {
    it(`mysql: ${name}`, () => {
      expect(mysqlUsers.build(SAMPLE_OPS[name])).toMatchSnapshot()
    })
    it(`postgres: ${name}`, () => {
      expect(pgUsers.build(SAMPLE_OPS[name])).toMatchSnapshot()
    })
  }

  it('masks passwords for previews and never leaks them', () => {
    for (const b of [mysqlUsers, pgUsers]) {
      const masked = b.build(SAMPLE_OPS.createUser, { mask: true }).join('\n')
      expect(masked).toContain('****')
      expect(masked).not.toContain("p'w")
      expect(b.build(SAMPLE_OPS.setPassword, { mask: true }).join('\n')).not.toContain('new')
    }
  })

  it('escapes user names and passwords', () => {
    expect(mysqlUsers.build(SAMPLE_OPS.dropUser)[0]).toBe("DROP USER 'o''brien'@'10.0.%'")
    expect(pgUsers.build(SAMPLE_OPS.dropUser)[0]).toBe('DROP ROLE "o\'brien"')
    expect(mysqlUsers.build(SAMPLE_OPS.setPassword)[0]).toContain("IDENTIFIED BY 'new'")
  })

  it('runs PostgreSQL grants inside the target database', () => {
    expect(pgUsers.namespace(SAMPLE_OPS.grantAll, 'postgres')).toEqual({ database: 'shop', schema: 'app' })
    expect(pgUsers.namespace(SAMPLE_OPS.dropUser, 'postgres')).toEqual({ database: 'postgres' })
    expect(mysqlUsers.namespace(SAMPLE_OPS.grantAll, 'information_schema')).toEqual({ database: 'information_schema' })
  })
})
