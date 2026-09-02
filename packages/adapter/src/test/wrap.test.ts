import { describe, expect, it } from 'vitest'
import { wrapReadOnly } from '../base.ts'

describe('wrapReadOnly', () => {
  it('wraps plain reads with a LIMIT and keeps the body verbatim', () => {
    expect(wrapReadOnly('SELECT * FROM t;', 101)).toBe('SELECT * FROM (SELECT * FROM t) AS _tsmyadmin LIMIT 101')
    expect(wrapReadOnly('  with x as (select 1) select * from x', 5)).toMatch(/^SELECT \* FROM \(with x/)
    expect(wrapReadOnly('VALUES (1), (2)', 2)).not.toBeNull()
    expect(wrapReadOnly('TABLE t', 2)).not.toBeNull()
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
