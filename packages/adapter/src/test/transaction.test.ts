import { describe, expect, it } from 'vitest'
import { leavesTransactionOpen } from '../sql/transaction.ts'

const mysql = (...s: string[]) => leavesTransactionOpen(s, 'mysql')
const pg = (...s: string[]) => leavesTransactionOpen(s, 'postgres')

describe('leavesTransactionOpen', () => {
  it('is false for a script that never opens one', () => {
    expect(mysql('SELECT 1', 'UPDATE t SET a = 1')).toBe(false)
    expect(pg('SELECT 1')).toBe(false)
    expect(mysql()).toBe(false)
  })

  it('reports an explicit transaction that is never closed', () => {
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1')).toBe(true)
    expect(pg('BEGIN', 'DELETE FROM t')).toBe(true)
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1', 'COMMIT')).toBe(false)
    expect(pg('BEGIN', 'DELETE FROM t', 'ROLLBACK')).toBe(false)
  })

  it('does not treat ROLLBACK TO SAVEPOINT as the end of the transaction', () => {
    expect(pg('BEGIN', 'SAVEPOINT s', 'ROLLBACK TO SAVEPOINT s')).toBe(true)
  })

  it('follows autocommit on MySQL: writes after SET autocommit = 0 are uncommitted', () => {
    expect(mysql('SET autocommit = 0', 'UPDATE t SET a = 1')).toBe(true)
    expect(mysql('SET autocommit = 0', 'UPDATE t SET a = 1', 'COMMIT')).toBe(false)
    expect(mysql('SET autocommit = 0', 'UPDATE t SET a = 1', 'SET autocommit = 1')).toBe(false)
    expect(mysql('SET SESSION autocommit = OFF', 'INSERT INTO t VALUES (1)')).toBe(true)
    // Nothing was written, so nothing is pending.
    expect(mysql('SET autocommit = 0')).toBe(false)
  })

  it("models MySQL's implicit commit on DDL, which PostgreSQL does not have", () => {
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1', 'CREATE TABLE x (a INT)')).toBe(false)
    expect(pg('BEGIN', 'UPDATE t SET a = 1', 'CREATE TABLE x (a int)')).toBe(true)
  })

  it('reads past leading comments', () => {
    expect(pg('-- open it\nBEGIN', '/* work */ UPDATE t SET a = 1')).toBe(true)
    expect(pg('BEGIN', '-- done\nCOMMIT')).toBe(false)
  })
})
