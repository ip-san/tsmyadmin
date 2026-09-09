import { describe, expect, it } from 'vitest'
import { type ExecutedStatement, leavesTransactionOpen } from '../sql/transaction.ts'

const ran = (s: string | ExecutedStatement): ExecutedStatement => (typeof s === 'string' ? { sql: s } : s)
const mysql = (...s: (string | ExecutedStatement)[]) => leavesTransactionOpen(s.map(ran), 'mysql')
const pg = (...s: (string | ExecutedStatement)[]) => leavesTransactionOpen(s.map(ran), 'postgres')
const failed = (sql: string): ExecutedStatement => ({ sql, failed: true })

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

  it('treats COMMIT AND CHAIN as opening the next transaction', () => {
    expect(pg('BEGIN', 'UPDATE t SET a = 1', 'COMMIT AND CHAIN')).toBe(true)
    expect(pg('BEGIN', 'UPDATE t SET a = 1', 'COMMIT AND CHAIN', 'COMMIT')).toBe(false)
  })

  it('follows autocommit on MySQL: writes after SET autocommit = 0 are uncommitted', () => {
    expect(mysql('SET autocommit = 0', 'UPDATE t SET a = 1')).toBe(true)
    expect(mysql('SET autocommit = 0', 'UPDATE t SET a = 1', 'COMMIT')).toBe(false)
    expect(mysql('SET autocommit = 0', 'UPDATE t SET a = 1', 'SET autocommit = 1')).toBe(false)
    expect(mysql('SET SESSION autocommit = OFF', 'INSERT INTO t VALUES (1)')).toBe(true)
    expect(mysql('SET @@session.autocommit = 0', 'INSERT INTO t VALUES (1)')).toBe(true)
    // Nothing was written, so nothing is pending.
    expect(mysql('SET autocommit = 0')).toBe(false)
    // A user variable that happens to be called @autocommit is not the system variable.
    expect(mysql('SET @autocommit = 0', 'UPDATE t SET a = 1')).toBe(false)
  })

  it("models MySQL's implicit commit on DDL, which PostgreSQL does not have", () => {
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1', 'CREATE TABLE x (a INT)')).toBe(false)
    expect(pg('BEGIN', 'UPDATE t SET a = 1', 'CREATE TABLE x (a int)')).toBe(true)
    // A DDL that failed still committed: MySQL commits before running it.
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1', failed('CREATE TABLE x (a INT)'))).toBe(false)
  })

  it('excludes TEMPORARY tables, which MySQL keeps inside the transaction', () => {
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1', 'CREATE TEMPORARY TABLE tmp (a INT)')).toBe(true)
    expect(mysql('START TRANSACTION', 'UPDATE t SET a = 1', 'DROP TEMPORARY TABLE tmp')).toBe(true)
  })

  it('ignores statements that failed, which changed nothing', () => {
    // `SET autocommit = off` is a syntax error on PostgreSQL: it must not produce a false warning.
    expect(pg(failed('SET autocommit = off'), 'SELECT 1')).toBe(false)
    expect(pg(failed('BEGIN'), 'SELECT 1')).toBe(false)
  })

  it('reads past leading comments', () => {
    expect(pg('-- open it\nBEGIN', '/* work */ UPDATE t SET a = 1')).toBe(true)
    expect(pg('BEGIN', '-- done\nCOMMIT')).toBe(false)
  })
})
