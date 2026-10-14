import type { StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { executed } from './databases.ts'

/** Statements outside a transaction, and transaction words with nothing open (found as surviving mutants; see `bun run mutation`). */

const ok = (sql: string, statement?: number): StatementResult => ({
  kind: 'affected',
  sql,
  affectedRows: 1,
  durationMs: 1,
  ...(statement === undefined ? {} : { statement }),
})
const failed = (sql: string, statement?: number): StatementResult => ({
  kind: 'error',
  sql,
  message: 'x',
  ...(statement === undefined ? {} : { statement }),
})

describe('executed: outside a transaction', () => {
  it('keeps a MySQL definition change on its own, once, in order', () => {
    expect(executed([ok('UPDATE a SET x = 1'), ok('ALTER TABLE a ADD y INT'), ok('DROP TABLE b')], 'mysql')).toEqual([
      'UPDATE a SET x = 1',
      'ALTER TABLE a ADD y INT',
      'DROP TABLE b',
    ])
    for (const ddl of ['CREATE TABLE t (a INT)', 'RENAME TABLE a TO b', 'TRUNCATE t', '  alter table a add b int'])
      expect(executed([ok(ddl)], 'mysql'), ddl).toEqual([ddl])
  })

  it('keeps a PostgreSQL definition change on its own', () => {
    expect(executed([ok('ALTER TABLE a ADD y INT')], 'postgres')).toEqual(['ALTER TABLE a ADD y INT'])
  })

  it('ignores COMMIT, END and ROLLBACK when no transaction is open, and carries on', () => {
    expect(executed([ok('COMMIT'), ok('UPDATE a SET x = 1')], 'postgres')).toEqual(['UPDATE a SET x = 1'])
    expect(executed([ok('END'), ok('ROLLBACK'), ok('UPDATE a SET x = 1')], 'mysql')).toEqual(['UPDATE a SET x = 1'])
  })
})

describe('executed: inside a transaction', () => {
  it('holds back the statements until COMMIT (or END), then keeps them in order', () => {
    expect(executed([ok('BEGIN'), ok('UPDATE a SET x = 1'), ok('UPDATE b SET x = 1')], 'postgres')).toEqual([])
    expect(executed([ok('BEGIN'), ok('UPDATE a SET x = 1'), ok('UPDATE b SET x = 1'), ok('END')], 'postgres')).toEqual([
      'UPDATE a SET x = 1',
      'UPDATE b SET x = 1',
    ])
    expect(
      executed([ok('begin'), ok('UPDATE a SET x = 1'), ok('commit'), ok('UPDATE b SET x = 1')], 'postgres')
    ).toEqual(['UPDATE a SET x = 1', 'UPDATE b SET x = 1'])
  })

  it('drops a rolled-back transaction and starts the next one empty', () => {
    expect(
      executed(
        [ok('BEGIN'), ok('UPDATE a SET x = 1'), ok('ROLLBACK'), ok('BEGIN'), ok('UPDATE b SET x = 1'), ok('COMMIT')],
        'postgres'
      )
    ).toEqual(['UPDATE b SET x = 1'])
  })

  it('a MySQL definition change commits what came before it, and what follows is held again only by a new BEGIN', () => {
    expect(
      executed(
        [
          ok('BEGIN'),
          ok('UPDATE a SET x = 1'),
          ok('ALTER TABLE a ADD y INT'),
          ok('UPDATE b SET x = 1'),
          ok('ROLLBACK'),
        ],
        'mysql'
      )
    ).toEqual(['UPDATE a SET x = 1', 'ALTER TABLE a ADD y INT', 'UPDATE b SET x = 1'])
  })

  it('a savepoint is not a change, in or out of a transaction', () => {
    expect(executed([ok('SAVEPOINT s1'), ok('RELEASE SAVEPOINT s1'), ok('UPDATE a SET x = 1')], 'postgres')).toEqual([
      'UPDATE a SET x = 1',
    ])
    expect(executed([ok('BEGIN'), ok('SAVEPOINT s1'), ok('UPDATE a SET x = 1'), ok('COMMIT')], 'postgres')).toEqual([
      'UPDATE a SET x = 1',
    ])
  })
})

describe('executed: failures and result sets', () => {
  it('a failed statement is not recorded, and does not stop the ones after it', () => {
    expect(executed([failed('UPDATE a SET x = 1'), ok('UPDATE b SET x = 1')], 'postgres')).toEqual([
      'UPDATE b SET x = 1',
    ])
  })

  it('counts one statement once however many result sets it has, and a statement that failed is not "seen" as done', () => {
    expect(executed([ok('CALL p()', 3), ok('CALL p()', 3), ok('SELECT 1', 4)], 'mysql')).toEqual([
      'CALL p()',
      'SELECT 1',
    ])
    // Without a statement number, each result is its own statement, however alike.
    expect(executed([ok('UPDATE a SET x = 1'), ok('UPDATE a SET x = 1')], 'postgres')).toEqual([
      'UPDATE a SET x = 1',
      'UPDATE a SET x = 1',
    ])
    // A failure of statement 2 does not hide a later success of statement 3.
    expect(executed([failed('A', 2), ok('B', 3)], 'postgres')).toEqual(['B'])
  })
})
