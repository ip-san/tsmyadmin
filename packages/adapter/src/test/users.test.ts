import type { UserOp } from '@tsmyadmin/shared'
import { USER_OP_NAMES } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { MysqlAdapter } from '../mysql/adapter.ts'
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
  grantPrivileges: {
    op: 'grantPrivileges',
    user,
    privileges: ['SELECT', 'INSERT'],
    database: 'shop',
    schema: 'app',
    table: 'ord ers',
  },
  revokePrivileges: { op: 'revokePrivileges', user, privileges: ['SELECT'], database: 'shop', schema: 'app' },
}

/**
 * Column grants are not separate ops, so SAMPLE_OPS completeness does not reach them: they get their own
 * snapshots. The column name is quoting-hostile on purpose — a bare join would produce invalid SQL.
 */
const COLUMN_OPS = {
  grant: {
    op: 'grantPrivileges',
    user,
    privileges: ['SELECT', 'UPDATE'],
    database: 'shop',
    schema: 'app',
    table: 'ord ers',
    columns: ['na"me', 'no`te'],
  },
  revoke: {
    op: 'revokePrivileges',
    user,
    privileges: ['SELECT'],
    database: 'shop',
    schema: 'app',
    table: 'ord ers',
    columns: ['na"me'],
  },
} satisfies Record<string, UserOp>

describe('user SQL builders', () => {
  it('has a sample for every UserOp', () => {
    expect(Object.keys(SAMPLE_OPS).sort()).toEqual([...USER_OP_NAMES].sort())
  })

  for (const name of USER_OP_NAMES) {
    it(`mysql: ${name}`, () => {
      expect(mysqlUsers.build(SAMPLE_OPS[name]).map((s) => s.sql)).toMatchSnapshot()
    })
    it(`postgres: ${name}`, () => {
      expect(pgUsers.build(SAMPLE_OPS[name]).map((s) => s.sql)).toMatchSnapshot()
    })
  }

  for (const [kind, op] of Object.entries(COLUMN_OPS)) {
    it(`mysql: ${kind} on named columns`, () => {
      expect(mysqlUsers.build(op).map((s) => s.sql)).toMatchSnapshot()
    })
    it(`postgres: ${kind} on named columns`, () => {
      expect(pgUsers.build(op).map((s) => s.sql)).toMatchSnapshot()
    })
  }

  it('quotes column names per dialect and repeats them for each privilege', () => {
    const mysql = mysqlUsers.build(COLUMN_OPS.grant)[0]?.sql ?? ''
    expect(mysql).toContain('GRANT SELECT (`na"me`, `no``te`), UPDATE (`na"me`, `no``te`) ON')
    // The columns of a table grant are plain identifiers: the LIKE escaping of `db.*` must not reach them.
    expect(mysql).not.toContain('\\_')
    const pg = pgUsers.build(COLUMN_OPS.grant).map((x) => x.sql)
    expect(pg.at(-1)).toContain('GRANT SELECT ("na""me", "no`te"), UPDATE ("na""me", "no`te") ON')
  })

  it('leaves a grant without columns unchanged', () => {
    expect(mysqlUsers.build(SAMPLE_OPS.grantPrivileges)[0]?.sql).toContain('GRANT SELECT, INSERT ON')
  })

  it('masks passwords in display text and never leaks them', () => {
    for (const b of [mysqlUsers, pgUsers]) {
      const display = b
        .build(SAMPLE_OPS.createUser)
        .map((s) => s.display)
        .join('\n')
      expect(display).toContain('****')
      expect(display).not.toContain("p'w")
      expect(
        b
          .build(SAMPLE_OPS.setPassword)
          .map((s) => s.display)
          .join('\n')
      ).not.toContain('new')
      expect(b.build(SAMPLE_OPS.dropUser)[0]?.display).toBe(b.build(SAMPLE_OPS.dropUser)[0]?.sql)
    }
  })

  it('escapes user names and passwords', () => {
    expect(mysqlUsers.build(SAMPLE_OPS.dropUser)[0]?.sql).toBe("DROP USER 'o''brien'@'10.0.%'")
    expect(pgUsers.build(SAMPLE_OPS.dropUser)[0]?.sql).toBe('DROP ROLE "o\'brien"')
    expect(mysqlUsers.build(SAMPLE_OPS.setPassword)[0]?.sql).toContain("IDENTIFIED BY 'new'")
  })

  it('runs PostgreSQL grants inside the target database', () => {
    expect(pgUsers.namespace(SAMPLE_OPS.grantAll, { database: 'postgres' })).toEqual({
      database: 'shop',
      schema: 'app',
    })
    expect(pgUsers.namespace(SAMPLE_OPS.dropUser, { database: 'postgres' })).toEqual({ database: 'postgres' })
    expect(mysqlUsers.namespace(SAMPLE_OPS.grantAll, { database: 'information_schema' })).toEqual({
      database: 'information_schema',
    })
  })
})

describe('MysqlAdapter.toAdapterError', () => {
  it('names MariaDB-only errno values the driver has no symbol for', () => {
    const a = new MysqlAdapter({ dialect: 'mysql', host: 'h', port: 1, user: 'u', password: 'p' })
    expect(a.toAdapterError({ errno: 1969, sqlMessage: 'Query execution was interrupted' })).toMatchObject({
      code: 'QUERY_FAILED',
      nativeCode: 'ER_STATEMENT_TIMEOUT',
    })
    expect(a.toAdapterError({ errno: 4242, message: 'x' })).toMatchObject({ nativeCode: 'ER_4242' })
    expect(a.toAdapterError({ code: 'ER_NO_SUCH_TABLE', sqlMessage: 'missing' })).toMatchObject({
      code: 'NOT_FOUND',
      nativeCode: 'ER_NO_SUCH_TABLE',
    })
  })
})
