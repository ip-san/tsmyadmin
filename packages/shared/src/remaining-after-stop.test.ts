import { describe, expect, it } from 'vitest'
import { remainingAfterStop } from './remaining-after-stop.ts'
import type { StatementResult } from './schemas/result.ts'

const ok = (sql: string, statement: number | undefined): StatementResult => ({
  kind: 'affected',
  sql,
  affectedRows: 0,
  durationMs: 1,
  ...(statement === undefined ? {} : { statement }),
})
const stopped = (sql: string, statement: number): StatementResult => ({
  kind: 'error',
  sql,
  statement,
  message: 'The statement was stopped',
})
const sql = ['ALTER TABLE t ADD a INT', 'CREATE INDEX i ON t (a)', 'ALTER TABLE t ADD b INT']

describe('remainingAfterStop', () => {
  it('starts at the statement the stop cut short', () => {
    expect(remainingAfterStop(sql, [ok(sql[0] ?? '', 0), stopped(sql[1] ?? '', 1)])).toEqual(sql.slice(1))
  })

  it('starts after the last statement that ended, where the stop came between two', () => {
    expect(remainingAfterStop(sql, [ok(sql[0] ?? '', 0)])).toEqual(sql.slice(1))
    expect(remainingAfterStop(sql, [])).toEqual(sql)
    // Ended whole: nothing left. Several result sets of one statement share its position.
    expect(
      remainingAfterStop(
        sql,
        sql.flatMap((s, i) => [ok(s, i), ok(s, i)])
      )
    ).toEqual([])
  })

  it('starts again at the BEGIN of a transaction the stop rolled back, not after it', () => {
    const tx = ['BEGIN', 'CREATE INDEX i ON t (a)', "COMMENT ON INDEX i IS 'x'", 'COMMIT', 'ANALYZE t']
    const ran = (n: number) => tx.slice(0, n).map((s, i) => ok(s, i))
    expect(remainingAfterStop(tx, ran(2))).toEqual(tx)
    expect(remainingAfterStop(tx, [...ran(2), stopped(tx[2] ?? '', 2)])).toEqual(tx)
    // Committed: what it did stays.
    expect(remainingAfterStop(tx, ran(4))).toEqual(['ANALYZE t'])
    // The other spelling of BEGIN is read as one (DML only: MySQL's DDL commits on its own).
    const mysql = ['START TRANSACTION', 'INSERT INTO t VALUES (1)', 'COMMIT']
    expect(remainingAfterStop(mysql, [ok('START TRANSACTION', 0)])).toEqual(mysql)
  })

  it('does not give a rest where it cut short a build that does not stop writes (it leaves an index behind)', () => {
    const online = [
      'DROP INDEX CONCURRENTLY IF EXISTS "app"."i"',
      'CREATE UNIQUE INDEX CONCURRENTLY "i" ON "app"."t" ("a")',
      `COMMENT ON INDEX "app"."i" IS 'c'`,
    ]
    expect(remainingAfterStop(online, [ok(online[0] ?? '', 0), stopped(online[1] ?? '', 1)])).toBeNull()
    // Stopped after it, the index was made: the rest is the rest.
    expect(remainingAfterStop(online, [ok(online[0] ?? '', 0), ok(online[1] ?? '', 1)])).toEqual(online.slice(2))
  })

  it('reads text around a statement as the same statement', () => {
    expect(remainingAfterStop(sql, [ok(`\n${sql[0]}\n`, 0)])).toEqual(sql.slice(1))
  })

  it('does not know what ran where a result has no position, or is of another statement', () => {
    expect(remainingAfterStop(sql, [ok(sql[0] ?? '', undefined)])).toBeNull()
    expect(remainingAfterStop(sql, [ok(sql[1] ?? '', 0)])).toBeNull()
    expect(remainingAfterStop(sql, [ok('SELECT 1', 7)])).toBeNull()
    // Stopped on its COMMIT: the transaction may have committed first.
    const tx = ['BEGIN', 'CREATE INDEX i ON t (a)', 'COMMIT']
    expect(remainingAfterStop(tx, [ok('BEGIN', 0), ok(tx[1] ?? '', 1), stopped('COMMIT', 2)])).toBeNull()
  })
})
