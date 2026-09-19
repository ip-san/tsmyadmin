import type { UserOp } from '@tsmyadmin/shared'
import { USER_OP_NAMES } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { hasSystemUser, mysqlUsers } from '../mysql/users.ts'
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
  lockUser: { op: 'lockUser', user, locked: true },
  renameUser: { op: 'renameUser', user, newUser: { name: 'new"name', host: 'localhost' } },
  copyUser: {
    op: 'copyUser',
    user,
    newUser: { name: "c'opy", host: '%' },
    password: 'pw',
    grants: [
      "GRANT USAGE ON *.* TO `o'brien`@`10.0.%`",
      "GRANT SELECT, INSERT ON `shop`.* TO `o'brien`@`10.0.%` WITH GRANT OPTION",
      'GRANT SELECT ON "shop"."t" TO "o\'brien"',
      'ALTER ROLE "o\'brien" NOSUPERUSER LOGIN',
    ],
  },
  setAccountLimits: {
    op: 'setAccountLimits',
    user,
    require: 'SSL',
    maxQueries: 100,
    maxUpdates: 0,
    maxConnections: 20,
    maxUserConnections: 5,
  },
  changeGlobalPrivileges: {
    op: 'changeGlobalPrivileges',
    user,
    grant: ['PROCESS', 'RELOAD', 'GRANT OPTION'],
    revoke: ['FILE'],
  },
  alterRole: { op: 'alterRole', user, superuser: false, createdb: true, replication: true, login: false },
  grantRoutinePrivileges: {
    op: 'grantRoutinePrivileges',
    user,
    privileges: ['EXECUTE'],
    database: 'shop',
    schema: 'app',
    routine: 'do"it',
    kind: 'FUNCTION',
    parameters: 'integer, text',
  },
  revokeRoutinePrivileges: {
    op: 'revokeRoutinePrivileges',
    user,
    privileges: ['EXECUTE'],
    database: 'shop',
    routine: 'p`roc',
    kind: 'PROCEDURE',
  },
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

/** Options of createUser that the samples above do not use. */
const CREATE_OPTIONS = {
  plugin: {
    op: 'createUser',
    user,
    password: 'pw',
    attributes: { superuser: false, createdb: false, createrole: false },
    plugin: 'caching_sha2_password',
  },
  ownDatabase: {
    op: 'createUser',
    user: { name: 'my_app', host: 'localhost' },
    password: 'pw',
    attributes: { superuser: false, createdb: false, createrole: false },
    createDatabase: true,
    grantWildcard: true,
  },
} satisfies Record<string, UserOp>

describe('user SQL builders', () => {
  for (const [kind, op] of Object.entries(CREATE_OPTIONS)) {
    it(`mysql: createUser with ${kind}`, () => {
      expect(mysqlUsers.build(op).map((s) => s.sql)).toMatchSnapshot()
    })
    it(`postgres: createUser with ${kind} is refused`, () => {
      expect(() => pgUsers.build(op)).toThrow(/MySQL options/)
    })
  }

  it('has a sample for every UserOp', () => {
    expect(Object.keys(SAMPLE_OPS).sort()).toEqual([...USER_OP_NAMES].sort())
  })

  /** The statements, or the refusal for an op the dialect has no equivalent of. */
  const built = (builder: typeof mysqlUsers, op: UserOp) => {
    try {
      return builder.build(op).map((s) => s.sql)
    } catch (err) {
      return [`refused: ${(err as Error).message}`]
    }
  }

  for (const name of USER_OP_NAMES) {
    it(`mysql: ${name}`, () => {
      expect(built(mysqlUsers, SAMPLE_OPS[name])).toMatchSnapshot()
    })
    it(`postgres: ${name}`, () => {
      expect(built(pgUsers, SAMPLE_OPS[name])).toMatchSnapshot()
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

describe('hasSystemUser', () => {
  it('knows which servers have SYSTEM_USER, and assumes it where the version cannot be read', () => {
    expect(hasSystemUser('8.4.11')).toBe(true)
    expect(hasSystemUser('8.0.16')).toBe(true)
    expect(hasSystemUser('8.0.15')).toBe(false)
    expect(hasSystemUser('5.7.44-log')).toBe(false)
    expect(hasSystemUser('11.4.2-MariaDB-ubu2404')).toBe(false)
    // Asking for SYSTEM_USER only makes canManageAccount stricter, so an unreadable version must not skip it.
    expect(hasSystemUser('8.0.x-proxy')).toBe(true)
    expect(hasSystemUser('')).toBe(true)
  })
})
