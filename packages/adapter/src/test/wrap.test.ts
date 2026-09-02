import { describe, expect, it } from 'vitest'
import { escapeLike, wrapReadOnly } from '../base.ts'

describe('wrapReadOnly', () => {
  it('wraps plain reads with a LIMIT and keeps the body verbatim', () => {
    expect(wrapReadOnly('SELECT * FROM t;', 101)).toBe('SELECT * FROM (\nSELECT * FROM t\n) AS _tsmyadmin LIMIT 101')
    expect(wrapReadOnly('  with x as (select 1) select * from x', 5)).toMatch(/^SELECT \* FROM \(\nwith x/)
    expect(wrapReadOnly('VALUES (1), (2)', 2)).not.toBeNull()
    expect(wrapReadOnly('TABLE t', 2)).not.toBeNull()
  })

  it('ignores leading comments, keeps them in the body, and survives a trailing line comment', () => {
    const wrapped = wrapReadOnly('-- note\nSELECT 1 AS a -- trailing', 3)
    expect(wrapped).toBe('SELECT * FROM (\n-- note\nSELECT 1 AS a -- trailing\n) AS _tsmyadmin LIMIT 3')
    expect(wrapReadOnly('/* c */ (SELECT 1)', 3)).not.toBeNull()
    expect(wrapReadOnly('# mysql comment\nSELECT 2', 3)).not.toBeNull()
  })

  it('never wraps data-modifying CTEs', () => {
    expect(wrapReadOnly('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 3)).toBeNull()
    expect(wrapReadOnly('WITH c AS (SELECT 1) UPDATE t SET a = 1', 3)).toBeNull()
    expect(wrapReadOnly('WITH c AS (SELECT 1) MERGE INTO t USING c ON true WHEN MATCHED THEN DELETE', 3)).toBeNull()
  })

  it('leaves everything else as written', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'EXPLAIN SELECT 1',
      'SHOW TABLES',
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t LOCK IN SHARE MODE',
      "SELECT * INTO OUTFILE '/tmp/x' FROM t",
      'SELECT @x := 1 INTO @y',
      'UPDATE t SET a = 1',
    ])
      expect(wrapReadOnly(sql, 10), sql).toBeNull()
  })
})

describe('escapeLike', () => {
  it('escapes %, _ and the escape character itself', () => {
    expect(escapeLike('100%_!x')).toBe('100!%!_!!x')
    expect(escapeLike('plain')).toBe('plain')
  })
})
