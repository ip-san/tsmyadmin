import { describe, expect, it } from 'vitest'
import { DdlOpSchema, hasStatementBreak } from './ddl.ts'

describe('partition code', () => {
  it('refuses a ; outside quoted literals, and keeps one inside them', () => {
    expect(hasStatementBreak('VALUES LESS THAN (100); DROP TABLE x')).toBe(true)
    expect(hasStatementBreak("VALUES IN ('a;b', 'it''s; fine')")).toBe(false)
    expect(hasStatementBreak('FOR VALUES IN ("x;y")')).toBe(false)
    const add = (bound: string) =>
      DdlOpSchema.safeParse({ op: 'addPartition', table: 't', partition: { name: 'p', bound } }).success
    expect(add('FOR VALUES FROM (1) TO (10)')).toBe(true)
    expect(add('FOR VALUES FROM (1) TO (10); DROP TABLE t')).toBe(false)
    expect(
      DdlOpSchema.safeParse({ op: 'partitionTable', table: 't', method: 'hash', expression: 'id; DROP TABLE t' })
        .success
    ).toBe(false)
  })

  it('refuses a comment or a statement break in a PostgreSQL routine signature', () => {
    const drop = (parameters: string) =>
      DdlOpSchema.safeParse({ op: 'dropRoutine', kind: 'function', name: 'f', parameters }).success
    expect(drop('IN a integer, b text')).toBe(true)
    expect(drop('integer) CASCADE --')).toBe(false)
    expect(drop('integer /* x */')).toBe(false)
    expect(drop('integer); DROP TABLE t')).toBe(false)
  })
})
