import type { StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { executed } from './databases.ts'

const ok = (sql: string, statement?: number): StatementResult => ({
  kind: 'affected',
  sql,
  affectedRows: 1,
  durationMs: 1,
  ...(statement === undefined ? {} : { statement }),
})
const failed = (sql: string): StatementResult => ({ kind: 'error', sql, message: 'x' })

describe('executed (what tracking records)', () => {
  it('keeps what stayed: not failures, not a rolled-back or still-open transaction', () => {
    expect(executed([ok('UPDATE a SET x = 1'), failed('UPDATE b SET x = 1')], 'postgres')).toEqual([
      'UPDATE a SET x = 1',
    ])
    expect(
      executed([ok('BEGIN'), ok('UPDATE a SET x = 1'), ok('ROLLBACK'), ok('UPDATE b SET x = 1')], 'postgres')
    ).toEqual(['UPDATE b SET x = 1'])
    expect(executed([ok('START TRANSACTION'), ok('UPDATE a SET x = 1'), ok('COMMIT')], 'mysql')).toEqual([
      'UPDATE a SET x = 1',
    ])
    // Left open: the connection rolls it back when the script ends.
    expect(executed([ok('BEGIN'), ok('UPDATE a SET x = 1')], 'postgres')).toEqual([])
    // A savepoint rollback keeps the transaction going.
    expect(executed([ok('BEGIN'), ok('UPDATE a SET x = 1'), ok('ROLLBACK TO s1'), ok('COMMIT')], 'postgres')).toEqual([
      'UPDATE a SET x = 1',
    ])
  })

  it("follows MySQL's implicit commit on a definition change, and PostgreSQL's transactional DDL", () => {
    const script = [ok('BEGIN'), ok('UPDATE a SET x = 1'), ok('ALTER TABLE a ADD y INT'), ok('ROLLBACK')]
    expect(executed(script, 'mysql')).toEqual(['UPDATE a SET x = 1', 'ALTER TABLE a ADD y INT'])
    expect(executed(script, 'postgres')).toEqual([])
    // One statement, several result sets (a CALL): recorded once.
    expect(executed([ok('CALL p()', 0), ok('CALL p()', 0)], 'mysql')).toEqual(['CALL p()'])
  })
})
