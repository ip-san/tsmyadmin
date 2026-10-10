import type { Cell, Dialect, Filter, ReplicationOp, RowKey } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { refuses } from '../test/ddl-helpers.ts'
import { toDbValue } from './cells.ts'
import { bitLiteral, buildKeyWhere, type ConditionHooks, conditionSql } from './conditions.ts'
import { cellLiteral } from './literal.ts'
import { privilegeList } from './privileges.ts'
import { Params, quoteIdent } from './quote.ts'
import { buildReplicationOp } from './replication.ts'

/** The error kinds, boundaries and small branches the neighbouring tests leave unchecked (found by mutation testing). */

const hooks = (dialect: Dialect): ConditionHooks => ({
  dialect,
  keyParam: (p) => p,
  keyMatchExpr: (e) => e,
  nullSafeEq: () => '<=>',
})
const bind = (v: unknown) => `<${String(v)}>`
const cond = (dialect: Dialect, f: Partial<Filter> & { op: Filter['op'] }) =>
  conditionSql(hooks(dialect), '`c`', { column: 'c', ...f } as Filter, '', bind)

describe('conditions: refusals and edges', () => {
  it('refuses a filter that needs a value, or a number of values, with the kind and a message saying which', () => {
    refuses(() => cond('mysql', { op: 'eq' }), 'QUERY_FAILED', /Filter "eq" on c requires a value/)
    refuses(() => cond('mysql', { op: 'between', values: [1] }), 'VALIDATION', /Filter "between" on c takes two values/)
    refuses(() => cond('mysql', { op: 'not_between', values: [1, 2, 3] }), 'VALIDATION', /takes two values/)
    refuses(() => cond('mysql', { op: 'in', values: [] }), 'VALIDATION', /Filter "in" on c takes at least one value/)
    refuses(() => cond('mysql', { op: 'not_in' }), 'VALIDATION', /takes at least one value/)
  })

  it('takes an absent value of a text match as the empty text, and a null value as a value', () => {
    expect(cond('mysql', { op: 'contains', value: null })).toBe("`c` LIKE <%%> ESCAPE '!'")
    expect(cond('mysql', { op: 'starts_with', value: '' })).toBe("`c` LIKE <%> ESCAPE '!'")
    expect(cond('mysql', { op: 'eq', value: null })).toBe('`c` = <null>')
  })

  it('writes like and not like on the text form, and the regular-expression forms of each dialect', () => {
    expect(cond('mysql', { op: 'like', value: 'a%' })).toBe('`c` LIKE <a%>')
    expect(cond('mysql', { op: 'not_like', value: 'a%' })).toBe('`c` NOT LIKE <a%>')
    expect(cond('postgres', { op: 'like', value: 'a%' })).toBe('`c`::text LIKE <a%>')
    expect(cond('postgres', { op: 'not_like', value: 'a%' })).toBe('`c`::text NOT LIKE <a%>')
    expect(cond('postgres', { op: 'regexp', value: 'x' })).toBe('`c`::text ~ <x>')
    expect(cond('postgres', { op: 'not_regexp', value: 'x' })).toBe('`c`::text !~ <x>')
    expect(cond('mysql', { op: 'regexp', value: 'x' })).toBe('`c` REGEXP <x>')
    expect(cond('mysql', { op: 'not_regexp', value: 'x' })).toBe('`c` NOT REGEXP <x>')
  })

  it('accepts a BIT number with blanks around it, and refuses anything else with the kind VALIDATION', () => {
    expect(bitLiteral(' 170 ')).toBe("X'aa'")
    expect(bitLiteral('\t5\n')).toBe("X'05'")
    expect(bitLiteral(0)).toBe("X'00'")
    refuses(() => bitLiteral('abc'), 'VALIDATION', /A BIT value must be a whole number from 0 to 18446744073709551615/)
    refuses(() => bitLiteral('18446744073709551616'), 'VALIDATION', /whole number/)
    expect(bitLiteral('18446744073709551615')).toBe("X'ffffffffffffffff'")
  })

  it('refuses a key with no values, or of a kind the dialect lacks, with the kind of the refusal', () => {
    const where = (d: Dialect, key: RowKey) => buildKeyWhere(hooks(d), key, new Params(d), new Map())
    refuses(() => where('mysql', { kind: 'pk', values: {} }), 'KEY_MISMATCH', /Primary key values are empty/)
    refuses(() => where('mysql', { kind: 'all-columns', values: {} }), 'KEY_MISMATCH', /Key values are empty/)
    refuses(
      () => where('postgres', { kind: 'all-columns', values: { a: 1 } }),
      'UNSUPPORTED',
      /only supported on MySQL/
    )
    refuses(() => where('mysql', { kind: 'ctid', value: '(0,1)' }), 'UNSUPPORTED', /only supported on PostgreSQL/)
  })
})

describe('Params', () => {
  it('hands back a placeholder per value: ? on MySQL, $n on PostgreSQL', () => {
    const my = new Params('mysql')
    expect([my.add('a'), my.add('b')]).toEqual(['?', '?'])
    expect(my.values).toEqual(['a', 'b'])
    const pg = new Params('postgres')
    expect([pg.add('a'), pg.add('b')]).toEqual(['$1', '$2'])
  })

  it('in literal mode hands back the value written as SQL, bytes included, and keeps the values too', () => {
    const my = new Params('mysql', true)
    expect(my.add("it's")).toBe("'it''s'")
    expect(my.add(new Uint8Array([1, 255]))).toBe("X'01ff'")
    expect(my.add(null)).toBe('NULL')
    expect(my.add(7)).toBe('7')
    expect(my.values).toHaveLength(4)
    expect(new Params('postgres', true).add(new Uint8Array([1, 255]))).toBe("'\\x01ff'::bytea")
    expect(toDbValue({ $bin: 'AQ==' })).toEqual(Buffer.from([1]))
  })
})

describe('quoting', () => {
  it('refuses an identifier with a NUL byte, with the kind VALIDATION', () => {
    refuses(() => quoteIdent('mysql', 'a\0b'), 'VALIDATION', /Identifier contains a NUL byte/)
    refuses(() => quoteIdent('postgres', '\0'), 'VALIDATION', /NUL byte/)
    expect(quoteIdent('mysql', 'a`b')).toBe('`a``b`')
  })

  it('refuses to write a truncated text cell into a dump, as a programming error', () => {
    expect(() => cellLiteral('mysql', { $text: 'abc', length: 9 } as Cell)).toThrow(
      /truncated text cannot be written to a dump/
    )
    expect(cellLiteral('mysql', 'abc')).toBe("'abc'")
  })

  it('lists privileges, with the columns attached to each only when there are some', () => {
    expect(privilegeList('mysql', ['SELECT', 'UPDATE'])).toBe('SELECT, UPDATE')
    expect(privilegeList('mysql', ['SELECT', 'UPDATE'], [])).toBe('SELECT, UPDATE')
    expect(privilegeList('mysql', ['SELECT', 'UPDATE'], ['a', 'b'])).toBe('SELECT (`a`, `b`), UPDATE (`a`, `b`)')
    expect(privilegeList('postgres', ['SELECT'], ['a'])).toBe('SELECT ("a")')
  })
})

describe('replication statements', () => {
  const build = (mariadb: boolean, op: ReplicationOp) => buildReplicationOp('mysql', mariadb, op).map((s) => s.sql)

  it('starts and stops the threads asked for', () => {
    expect(build(false, { op: 'startReplica', threads: 'io' })).toEqual(['START REPLICA IO_THREAD'])
    expect(build(false, { op: 'startReplica', threads: 'sql' })).toEqual(['START REPLICA SQL_THREAD'])
    expect(build(false, { op: 'startReplica', threads: 'all' })).toEqual(['START REPLICA'])
    expect(build(false, { op: 'stopReplica', threads: 'io' })).toEqual(['STOP REPLICA IO_THREAD'])
    expect(build(false, { op: 'stopReplica', threads: 'all' })).toEqual(['STOP REPLICA'])
  })

  it('resets the replica, everything with ALL', () => {
    expect(build(false, { op: 'resetReplica', all: false })).toEqual(['STOP REPLICA', 'RESET REPLICA'])
    expect(build(false, { op: 'resetReplica', all: true })).toEqual(['STOP REPLICA', 'RESET REPLICA ALL'])
  })

  it('points the replica at a log file and position, each only when given', () => {
    const change = (extra: Partial<Extract<ReplicationOp, { op: 'changeSource' }>>) =>
      build(false, {
        op: 'changeSource',
        host: 'h',
        port: 3306,
        user: 'u',
        password: 'p',
        autoPosition: false,
        start: false,
        ...extra,
      })[1]
    const head =
      "CHANGE REPLICATION SOURCE TO SOURCE_HOST = 'h', SOURCE_PORT = 3306, SOURCE_USER = 'u', SOURCE_PASSWORD = 'p'"
    expect(change({})).toBe(head)
    expect(change({ logFile: 'bin.000007' })).toBe(`${head}, SOURCE_LOG_FILE = 'bin.000007'`)
    expect(change({ logPos: 120 })).toBe(`${head}, SOURCE_LOG_POS = 120`)
    expect(change({ logFile: 'bin.1', logPos: 4 })).toBe(`${head}, SOURCE_LOG_FILE = 'bin.1', SOURCE_LOG_POS = 4`)
    // GTID auto-positioning replaces the file and position.
    expect(change({ logFile: 'bin.1', logPos: 4, autoPosition: true })).toBe(`${head}, SOURCE_AUTO_POSITION = 1`)
  })

  it('refuses to point a PostgreSQL standby, which is configured elsewhere, with the kind UNSUPPORTED', () => {
    refuses(
      () => buildReplicationOp('postgres', false, { op: 'resetReplica', all: false }),
      'UNSUPPORTED',
      /primary_conninfo setting/
    )
    expect(buildReplicationOp('postgres', false, { op: 'startReplica', threads: 'all' }).map((s) => s.sql)).toEqual([
      'SELECT pg_wal_replay_resume()',
    ])
  })
})
