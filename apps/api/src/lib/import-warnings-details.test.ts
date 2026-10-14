import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { type Fail, ns, opts, scripted } from '../test/import-sql-harness.ts'
import { type ImportSqlOptions, importSql } from './import.ts'

/** The warnings of an SQL import: what a run that failed, stopped or was rolled back tells the user afterwards. */

describe('importSql: warnings', () => {
  const warn = async (
    text: string,
    over: Partial<ImportSqlOptions> = {},
    fail: (sql: string) => Fail | null = () => null,
    dialect: 'mysql' | 'postgres' = 'mysql',
    keep?: number
  ) => {
    const r = await importSql(scripted(fail, dialect, keep), ns, text, opts(over))
    if (r.format !== 'sql') throw new Error('sql result expected')
    return r.warnings
  }

  it('says nothing about a run that went through', async () => {
    expect(await warn('SELECT 1;\nSELECT 2')).toEqual([])
    expect(await warn('SELECT 1', { singleTransaction: true })).toEqual([])
  })

  it('flags a statement that moves the run to another database', async () => {
    for (const sql of ['USE other', 'create database x', 'DROP DATABASE x', '/* c */ USE other', '-- c\nuse other']) {
      expect(await warn(`SELECT 1;\n${sql};`), sql).toEqual(['CHANGED_DATABASE'])
    }
    for (const sql of ['\\connect other', '\\c other']) {
      expect(await warn(`SELECT 1;\n${sql}\n`, {}, () => null, 'postgres'), sql).toEqual(['CHANGED_DATABASE'])
    }
    expect(await warn('/*!40000 USE other */;')).toEqual(['CHANGED_DATABASE'])
  })

  it('does not flag what only looks like one, or one that did not run', async () => {
    for (const sql of [
      'SELECT 1',
      'USERS 1',
      'UPDATE t SET a = 1',
      "INSERT INTO t VALUES ('USE x')",
      'CREATE TABLE t (a int)',
    ]) {
      expect(await warn(`${sql};`), sql).toEqual([])
    }
    expect(
      await warn('USE other;', { stopOnError: false }, (sql) => (sql === 'USE other' ? { message: 'no' } : null))
    ).toEqual([])
  })

  it('flags a run that was cut short when no error stopped it, or the server interrupted its last statement', async () => {
    const text = 'SELECT 1;\nSELECT 2;\nSELECT 3'
    // Fewer results than statements and no error: cancelled.
    expect(await warn(text, {}, () => null, 'mysql', 2)).toEqual(['CANCELLED'])
    expect(await warn(text, { stopOnError: false }, () => null, 'mysql', 2)).toEqual(['CANCELLED'])
    // The run stopped at the failing statement it was told to stop at: not cancelled.
    const stopAt2 = (sql: string) => (sql === 'SELECT 2' ? { message: 'x' } : null)
    expect(await warn(text, { stopOnError: true }, stopAt2, 'mysql', 2)).toEqual([])
    expect(await warn(text, { stopOnError: false, singleTransaction: false }, stopAt2, 'mysql', 2)).toEqual([
      'CANCELLED',
    ])
    // In one transaction it stops at the first error by definition (and says what was rolled back).
    expect(await warn(text, { stopOnError: false, singleTransaction: true }, stopAt2, 'mysql', 3)).toEqual([
      'ALL_ROLLED_BACK',
    ])
    // Every statement ran: not cancelled, a failing one or not.
    expect(await warn(text, { stopOnError: false }, stopAt2)).toEqual([])
    // The server's own interruption is a cancel, even when the run was to stop at an error anyway.
    for (const nativeCode of ['ER_QUERY_INTERRUPTED', '57014']) {
      const killed = (sql: string) => (sql === 'SELECT 2' ? { message: 'x', nativeCode } : null)
      expect(await warn(text, { stopOnError: true }, killed, 'mysql', 2), nativeCode).toEqual(['CANCELLED'])
    }
    const other = (sql: string) => (sql === 'SELECT 3' ? { message: 'x', nativeCode: '1062' } : null)
    expect(await warn(text, { stopOnError: false }, other)).toEqual([])
  })

  it('says a run was cancelled when the server answered nothing at all', async () => {
    expect(await warn('SELECT 1;\nSELECT 2', {}, () => null, 'mysql', 0)).toEqual(['CANCELLED'])
  })

  it('says everything was rolled back when the COMMIT never got an answer', async () => {
    // The answers stop after BEGIN and the one statement: the COMMIT was not reached.
    const r = await importSql(scripted(undefined, 'mysql', 2), ns, 'INSERT 1', opts({ singleTransaction: true }))
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r).toMatchObject({ total: 1, statements: 1, failed: 0, errors: [] })
    expect(r.warnings).toEqual(['ALL_ROLLED_BACK'])
  })

  it('takes a transaction as closed when the adapter does not say one is open', async () => {
    class Silent extends FakeAdapter {
      override async executeSql(...args: Parameters<FakeAdapter['executeSql']>) {
        const { onTransactionOpen: _unused, ...rest } = args[2]
        return super.executeSql(args[0], args[1], rest)
      }
    }
    const a = new Silent({
      onSql: (_ns, _sql, o) =>
        (o.statements ?? []).map((st, i) => ({
          kind: 'affected' as const,
          sql: st.sql,
          line: st.line,
          statement: i,
          affectedRows: 1,
          durationMs: 1,
        })),
    })
    const r = await importSql(a, ns, 'INSERT 1', opts())
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r.warnings).toEqual([])
  })

  it('tells a transaction left open from one that was rolled back as a whole', async () => {
    // A BEGIN of the file's own that is never closed: the connection is reset, which rolls it back.
    expect(await warn('BEGIN;\nINSERT 1')).toEqual(['ROLLED_BACK'])
    expect(await warn('BEGIN;\nINSERT 1;\nCOMMIT')).toEqual([])
  })

  describe('after a rollback of the single transaction: was anything committed on the way?', () => {
    const rolledBack = async (statements: string[], dialect: 'mysql' | 'postgres') =>
      warn(
        `${statements.map((s) => `${s};`).join('\n')}\nFAIL;`,
        { singleTransaction: true },
        (sql) => (sql === 'FAIL' ? { message: 'x' } : null),
        dialect
      )

    it('MySQL: a COMMIT, a ROLLBACK, an END, DDL, a new transaction and a lock commit by themselves', async () => {
      for (const sql of [
        'COMMIT',
        'ROLLBACK',
        'END',
        'commit',
        'CREATE TABLE t (a int)',
        'DROP TABLE t',
        'ALTER TABLE t ADD b int',
        'TRUNCATE t',
        'RENAME TABLE a TO b',
        'GRANT ALL ON *.* TO u',
        'REVOKE ALL ON *.* FROM u',
        'LOCK TABLES t WRITE',
        'UNLOCK TABLES',
        'SET PASSWORD = "x"',
        'FLUSH TABLES',
        'ANALYZE TABLE t',
        'OPTIMIZE TABLE t',
        'REPAIR TABLE t',
        'CHECK TABLE t',
        'LOAD DATA INFILE "x" INTO TABLE t',
        'BEGIN',
        'START TRANSACTION',
      ]) {
        expect(await rolledBack(['INSERT 1', sql], 'mysql'), sql).toEqual(['PARTIALLY_ROLLED_BACK'])
      }
    })

    it('MySQL: ordinary statements, and a temporary table, leave it all to roll back', async () => {
      for (const sql of [
        'INSERT 1',
        'UPDATE t SET a = 1',
        'SELECT 1',
        'CREATE TEMPORARY TABLE t (a int)',
        'SET @a = 1',
        'DROP TEMPORARY TABLE t',
      ]) {
        expect(await rolledBack(['INSERT 1', sql], 'mysql'), sql).toEqual(['ALL_ROLLED_BACK'])
      }
    })

    it('PostgreSQL: only COMMIT, ROLLBACK and END commit; DDL is transactional and a nested BEGIN commits nothing', async () => {
      for (const sql of ['COMMIT', 'ROLLBACK', 'END']) {
        expect(await rolledBack(['INSERT 1', sql], 'postgres'), sql).toEqual(['PARTIALLY_ROLLED_BACK'])
      }
      for (const sql of [
        'BEGIN',
        'START TRANSACTION',
        'CREATE TABLE t (a int)',
        'ALTER TABLE t ADD b int',
        'DROP TABLE t',
        'INSERT 2',
      ]) {
        expect(await rolledBack(['INSERT 1', sql], 'postgres'), sql).toEqual(['ALL_ROLLED_BACK'])
      }
    })

    it('MySQL: turning autocommit back on after it was off commits; so does a value it cannot read', async () => {
      const partial = ['PARTIALLY_ROLLED_BACK']
      const all = ['ALL_ROLLED_BACK']
      expect(await rolledBack(['SET autocommit = 0', 'SET autocommit = 1'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = OFF', 'SET autocommit = ON'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = FALSE', 'SET autocommit = TRUE'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 0', 'SET autocommit = 2'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 1'], 'mysql')).toEqual(all)
      expect(await rolledBack(['SET autocommit = 0'], 'mysql')).toEqual(all)
      expect(await rolledBack(['SET autocommit = 0', 'SET autocommit = 0'], 'mysql')).toEqual(all)
      expect(await rolledBack(['SET autocommit = 2'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = @x'], 'mysql')).toEqual(partial)
      // Only the whole word counts as a value: "10" and "ONE" are not 1 and ON.
      expect(await rolledBack(['SET autocommit = 0', 'SET autocommit = 10'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 0', 'SET autocommit = 01'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 00'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 01'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 1x'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = x1'], 'mysql')).toEqual(partial)
      expect(await rolledBack(['SET autocommit = 1', 'SET autocommit = 0'], 'mysql')).toEqual(all)
      // Other settings are not autocommit.
      expect(await rolledBack(['SET @autocommit = 1', 'SET foo = 0', 'SET foo = 1'], 'mysql')).toEqual(all)
    })

    it('does not look at the statements that failed or did not run', async () => {
      // The only statement that would commit is the one that failed.
      const r = await warn('INSERT 1;\nCOMMIT', { singleTransaction: true }, (sql) =>
        sql === 'COMMIT' ? { message: 'x' } : null
      )
      expect(r).toEqual(['ALL_ROLLED_BACK'])
    })
  })
})
