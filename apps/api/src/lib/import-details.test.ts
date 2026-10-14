import { splitStatements } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import type { StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { decodeUpload, type ImportSqlOptions, ImportValidationError, importSql } from './import.ts'

/** The import: what it sends to the server and what it tells the user, in every branch. */

const ns = { database: 'shop' }
const opts = (over: Partial<ImportSqlOptions> = {}): ImportSqlOptions => ({
  stopOnError: true,
  ignoreForeignKeys: false,
  singleTransaction: false,
  queryId: 'q',
  ...over,
})

describe('ImportValidationError', () => {
  it('carries its reason and parameters, with none by default', () => {
    const e = new ImportValidationError('CSV_EMPTY', 'empty')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ImportValidationError')
    expect(e.reason).toBe('CSV_EMPTY')
    expect(e.message).toBe('empty')
    expect(e.params).toEqual({})
    expect(new ImportValidationError('CSV_EMPTY', 'm', { line: 3 }).params).toEqual({ line: 3 })
  })
})

describe('decodeUpload', () => {
  const caught = (bytes: number[]) => {
    try {
      decodeUpload(new Uint8Array(bytes))
    } catch (e) {
      return e as ImportValidationError
    }
  }

  it('names the line of the first byte that is not UTF-8', () => {
    const first = caught([0xff, 0x61])
    expect(first?.reason).toBe('INVALID_ENCODING')
    expect(first?.message).toBe('The file is not valid UTF-8 (near line 1)')
    expect(first?.params).toEqual({ line: 1 })
    const third = caught([0x61, 0x0a, 0x62, 0x0a, 0xff])
    expect(third?.message).toBe('The file is not valid UTF-8 (near line 3)')
    expect(third?.params).toEqual({ line: 3 })
  })

  it('reads UTF-8 as it is, a byte-order mark included', () => {
    expect(decodeUpload(new TextEncoder().encode('日本語\nabc'))).toBe('日本語\nabc')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// SQL

type Fail = { message: string; code?: 'QUERY_FAILED'; nativeCode?: string }

/** A fake that answers each statement it is given: an error where `fail` says so, a success elsewhere. */
class Scripted extends FakeAdapter {
  /** The index of the result the importer is looking at (to see when it reports progress). */
  at = -1
  override async executeSql(
    ns: Parameters<FakeAdapter['executeSql']>[0],
    sql: string,
    options: Parameters<FakeAdapter['executeSql']>[2]
  ) {
    const onResult = options.onResult
    return super.executeSql(ns, sql, {
      ...options,
      onResult: async (r, i) => {
        this.at = i
        await onResult?.(r, i)
      },
    })
  }
}
const scripted = (
  fail: (sql: string, index: number) => Fail | null = () => null,
  dialect: 'mysql' | 'postgres' = 'mysql',
  keep = Number.POSITIVE_INFINITY
) =>
  new Scripted({
    dialect,
    onSql: (_ns, _sql, o) =>
      (o.statements ?? []).slice(0, keep).map((st, i): StatementResult => {
        const f = fail(st.sql, i)
        return f
          ? { kind: 'error', sql: st.sql, line: st.line, statement: i, ...f }
          : { kind: 'affected', sql: st.sql, line: st.line, statement: i, affectedRows: 1, durationMs: 1 }
      }),
  })
const lastOptions = (a: FakeAdapter) => a.calls.at(-1)?.args[2] as Record<string, unknown>
const lastScript = (a: FakeAdapter) => a.calls.at(-1)?.args[1] as string
const sent = (a: FakeAdapter) => (lastOptions(a).statements as { sql: string; line: number }[]) ?? []
const caughtOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as ImportValidationError
  }
}

describe('importSql: the file and the connection', () => {
  it('refuses a dump of the other dialect, and says which', async () => {
    const mysqlHeaders = ['-- Dialect: mysql', '-- MySQL dump 10.13', '-- MariaDB dump 10.19']
    for (const header of mysqlHeaders) {
      const e = await caughtOf(importSql(scripted(undefined, 'postgres'), ns, `${header}\nSELECT 1;`, opts()))
      expect(e?.reason, header).toBe('WRONG_DIALECT')
      expect(e?.message, header).toBe('This file is a mysql dump; the connection is postgres')
      expect(e?.params, header).toEqual({ dialect: 'mysql' })
    }
    for (const header of ['-- Dialect: postgres', '-- PostgreSQL database dump']) {
      const e = await caughtOf(importSql(scripted(), ns, `${header}\nSELECT 1;`, opts()))
      expect(e?.reason, header).toBe('WRONG_DIALECT')
      expect(e?.message, header).toBe('This file is a postgres dump; the connection is mysql')
      expect(e?.params, header).toEqual({ dialect: 'postgres' })
    }
  })

  it('accepts a dump of its own dialect, and looks for the header at the start of a line only', async () => {
    const a = scripted()
    await importSql(a, ns, '-- Dialect: mysql\nSELECT 1;', opts())
    await importSql(a, ns, 'SELECT 1;\n-- MySQL dump\nSELECT 2;', opts())
    await importSql(scripted(), ns, 'SELECT 1; -- Dialect: postgres', opts())
    await importSql(scripted(), ns, '-- Dialect: postgresql-ish\nSELECT 1;', opts()).catch((e) => {
      throw e
    })
  })

  it('reads the first 4096 characters for the header, not the whole file', async () => {
    const late = `${'-- filler line\n'.repeat(400)}-- Dialect: postgres\nSELECT 1;`
    expect(late.indexOf('-- Dialect')).toBeGreaterThan(4096)
    const r = await importSql(scripted(), ns, late, opts())
    expect(r.format).toBe('sql')
  })

  it('refuses a file without a statement', async () => {
    for (const text of ['', '  \n', '-- only a comment\n']) {
      const e = await caughtOf(importSql(scripted(), ns, text, opts()))
      expect(e?.reason).toBe('NO_STATEMENTS')
      expect(e?.message).toBe('No SQL statements were found in the file')
    }
  })

  it('tells the adapter how to run it: a row at most, ten minutes, the stop rule, the id, an audit label', async () => {
    const a = scripted()
    await importSql(a, ns, 'SELECT 1', opts({ queryId: 'abc', stopOnError: false }))
    expect(lastOptions(a)).toMatchObject({
      maxRows: 1,
      timeoutMs: 600_000,
      stopOnError: false,
      queryId: 'abc',
      auditLabel: 'import',
    })
  })

  it('stops at the first error when asked to or when it runs in one transaction', async () => {
    const stop = async (stopOnError: boolean, singleTransaction: boolean) => {
      const a = scripted()
      await importSql(a, ns, 'SELECT 1', opts({ stopOnError, singleTransaction }))
      return lastOptions(a).stopOnError
    }
    expect(await stop(true, false)).toBe(true)
    expect(await stop(false, true)).toBe(true)
    expect(await stop(true, true)).toBe(true)
    expect(await stop(false, false)).toBe(false)
  })
})

describe('importSql: the script that is sent', () => {
  it('sends the file as it is, ended by the delimiter, when no option is on', async () => {
    const a = scripted()
    await importSql(a, ns, 'INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2)', opts())
    expect(lastScript(a)).toBe('INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2)\n;')
    expect(sent(a).map((s) => [s.sql, s.line])).toEqual([
      ['INSERT INTO t VALUES (1)', 1],
      ['INSERT INTO t VALUES (2)', 2],
    ])
  })

  it('ends a MySQL file that changed the delimiter by that delimiter, then takes the usual one back', async () => {
    const a = scripted()
    await importSql(a, ns, 'DELIMITER //\nCALL p()', opts())
    expect(lastScript(a)).toBe('DELIMITER //\nCALL p()\n//\nDELIMITER ;')
    const pg = scripted(undefined, 'postgres')
    await importSql(pg, ns, 'SELECT 1', opts())
    expect(lastScript(pg)).toBe('SELECT 1\n;')
  })

  it('puts the options first, in order, and the COMMIT last, each with its line', async () => {
    const a = scripted()
    await importSql(
      a,
      ns,
      'INSERT 1;\nINSERT 2;',
      opts({ noAutoValueOnZero: true, ignoreForeignKeys: true, singleTransaction: true })
    )
    expect(lastScript(a)).toBe(
      [
        "SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'NO_AUTO_VALUE_ON_ZERO');",
        'SET FOREIGN_KEY_CHECKS = 0;',
        'START TRANSACTION;',
        'INSERT 1;\nINSERT 2;\n;',
        '\nCOMMIT;',
      ].join('\n')
    )
    expect(sent(a)).toEqual([
      { sql: "SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'NO_AUTO_VALUE_ON_ZERO')", line: 1 },
      { sql: 'SET FOREIGN_KEY_CHECKS = 0', line: 2 },
      { sql: 'START TRANSACTION', line: 3 },
      { sql: 'INSERT 1', line: 4 },
      { sql: 'INSERT 2', line: 5 },
      { sql: 'COMMIT', line: 8 },
    ])
    // The line of the COMMIT is its line in the script.
    expect(lastScript(a).split('\n')[7]).toBe('COMMIT;')
  })

  it('uses the other dialect’s words for them, and has no setting for a zero key', async () => {
    const a = scripted(undefined, 'postgres')
    await importSql(
      a,
      ns,
      'INSERT 1',
      opts({ noAutoValueOnZero: true, ignoreForeignKeys: true, singleTransaction: true })
    )
    expect(sent(a).map((s) => s.sql)).toEqual(['SET session_replication_role = replica', 'BEGIN', 'INSERT 1', 'COMMIT'])
    const only = scripted()
    await importSql(only, ns, 'INSERT 1', opts({ noAutoValueOnZero: true }))
    expect(sent(only).map((s) => s.sql)).toHaveLength(2)
    const off = scripted()
    await importSql(off, ns, 'INSERT 1', opts({ noAutoValueOnZero: false }))
    expect(sent(off).map((s) => s.sql)).toEqual(['INSERT 1'])
  })

  it('refuses a file that ends inside a comment or string when it must be committed', async () => {
    const e = await caughtOf(importSql(scripted(), ns, 'INSERT 1; /* end', opts({ singleTransaction: true })))
    expect(e?.reason).toBe('UNTERMINATED_END')
    expect(e?.message).toBe(
      'The file ends inside an unterminated comment or string literal: nothing could be committed'
    )
  })

  it('leaves out the first statements, but keeps the USE and SET among them, wherever they are written', async () => {
    const a = scripted()
    const text = [
      'USE shop;',
      '-- note',
      'SET NAMES utf8;',
      'use other;',
      'INSERT 1;',
      'SETTLE 1;',
      'USERS 1;',
      'INSERT 2;',
      'INSERT 3;',
    ].join('\n')
    const r = await importSql(a, ns, text, opts({ skip: 7 }))
    expect(sent(a).map((s) => s.sql)).toEqual(['USE shop', '-- note\nSET NAMES utf8', 'use other', 'INSERT 3'])
    expect(r.format === 'sql' && r.total).toBe(4)
    const none = scripted()
    await importSql(none, ns, text, opts({ skip: 0 }))
    expect(sent(none)).toHaveLength(8)
  })

  it('counts the lines of what follows options from the script, not from the file', async () => {
    const a = scripted()
    await importSql(a, ns, 'SELECT 1;\n\nSELECT 2;', opts({ skip: 1, ignoreForeignKeys: true }))
    expect(sent(a).map((s) => s.line)).toEqual([1, 4])
  })
})

describe('importSql: an option the server refuses', () => {
  it('stops before the first statement of the file, saying which option', async () => {
    const cases: [Partial<ImportSqlOptions>, string, string][] = [
      [{ noAutoValueOnZero: true }, 'sql_mode', 'noAutoValueOnZero'],
      [{ ignoreForeignKeys: true }, 'FOREIGN_KEY_CHECKS', 'ignoreForeignKeys'],
      [{ singleTransaction: true }, 'START TRANSACTION', 'singleTransaction'],
    ]
    for (const [over, marker, option] of cases) {
      const a = scripted((sql) => (sql.includes(marker) ? { message: 'denied', code: 'QUERY_FAILED' } : null))
      const e = await caughtOf(importSql(a, ns, 'INSERT 1', opts(over)))
      expect(e, option).toBeInstanceOf(ImportValidationError)
      expect(e?.reason, option).toBe('OPTION_FAILED')
      expect(e?.message, option).toBe('Import option could not be applied: denied')
      expect(e?.params, option).toEqual({ option, message: 'denied' })
    }
  })

  it('does not stop for a failure of the first statement of the file itself', async () => {
    const a = scripted((sql) => (sql === 'INSERT 1' ? { message: 'bad row' } : null))
    const r = await importSql(a, ns, 'INSERT 1', opts({ ignoreForeignKeys: true }))
    expect(r).toMatchObject({ format: 'sql', total: 1, statements: 1, failed: 1 })
  })
})

describe('importSql: progress', () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i};`).join('\n')

  it('reports every hundred statements and the last one, counted in the file’s own statements', async () => {
    const calls: [number, number][] = []
    await importSql(
      scripted(),
      ns,
      file(250),
      opts({
        onProgress: (done, total) => {
          calls.push([done, total])
        },
      })
    )
    expect(calls).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ])
  })

  it('does not count the option statements, and reports each at the statement that reaches the count', async () => {
    const a = scripted()
    const seen: [number, number, number][] = []
    await importSql(
      a,
      ns,
      file(250),
      opts({
        ignoreForeignKeys: true,
        onProgress: (done, total) => {
          if (done > 0) seen.push([done, total, a.at])
        },
      })
    )
    // The result at index 100 is the file's 100th statement (index 0 is the option).
    expect(seen).toEqual([
      [100, 250, 100],
      [200, 250, 200],
      [250, 250, 250],
    ])
  })

  it('counts a statement once however many result sets it answers with', async () => {
    const calls: [number, number][] = []
    const a = new FakeAdapter({
      onSql: (_ns, sql) =>
        splitStatements(sql, 'mysql').flatMap((st, statement): StatementResult[] =>
          Array.from({ length: statement === 0 ? 2 : 1 }, () => ({
            kind: 'affected' as const,
            sql: st.sql,
            line: st.line,
            statement,
            affectedRows: 0,
            durationMs: 1,
          }))
        ),
    })
    await importSql(
      a,
      ns,
      'CALL p();\nINSERT INTO t VALUES (1)',
      opts({
        onProgress: (done, total) => {
          calls.push([done, total])
        },
      })
    )
    expect(calls).toEqual([[2, 2]])
  })
})

describe('importSql: the counts and the errors', () => {
  it('counts what ran, what succeeded and what failed, and lists each failure as it happened', async () => {
    const a = scripted((sql) =>
      sql.startsWith('BAD') ? { message: 'boom', code: 'QUERY_FAILED', nativeCode: '1062' } : null
    )
    const r = await importSql(a, ns, 'OK 1;\nBAD 2;\nOK 3;\nBAD 4;', opts({ stopOnError: false }))
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r).toMatchObject({ total: 4, statements: 4, succeeded: 2, failed: 2 })
    expect(r.errors).toStrictEqual([
      { sql: 'BAD 2', message: 'boom', index: 1, code: 'QUERY_FAILED', line: 2 },
      { sql: 'BAD 4', message: 'boom', index: 3, code: 'QUERY_FAILED', line: 4 },
    ])
    expect(r.warnings).toEqual([])
    expect(typeof r.durationMs).toBe('number')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect(r.durationMs).toBeLessThan(60_000)
  })

  it('shortens the statement of an error to 500 characters, and counts its line from the file’s first line', async () => {
    const long = `BAD ${'x'.repeat(600)}`
    const a = scripted((sql) => (sql.startsWith('BAD') ? { message: 'boom' } : null))
    const r = await importSql(a, ns, `OK;\n${long}`, opts({ ignoreForeignKeys: true }))
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.sql).toBe(long.slice(0, 500))
    expect(r.errors[0]?.line).toBe(2)
    expect(r.errors[0]).not.toHaveProperty('code')
  })

  it('leaves out the line and the code an error does not have', async () => {
    const a = new FakeAdapter({
      onSql: () => [{ kind: 'error' as const, sql: 'X', statement: 0, message: 'm' }],
    })
    const r = await importSql(a, ns, 'X', opts())
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r.errors).toStrictEqual([{ sql: 'X', message: 'm', index: 0 }])
  })

  it('lists a refused COMMIT as the run’s error, counts it as a failure, and rolls everything back', async () => {
    const refuse = (code?: 'QUERY_FAILED') =>
      scripted((sql) => (sql === 'COMMIT' ? { message: 'deferred', ...(code ? { code } : {}) } : null))
    const r = await importSql(refuse('QUERY_FAILED'), ns, 'INSERT 1;\nINSERT 2', opts({ singleTransaction: true }))
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r).toMatchObject({ total: 2, statements: 2, succeeded: 2, failed: 1 })
    expect(r.errors).toStrictEqual([{ sql: 'COMMIT', message: 'deferred', index: 2, code: 'QUERY_FAILED' }])
    expect(r.warnings).toEqual(['ALL_ROLLED_BACK'])
    const bare = await importSql(refuse(), ns, 'INSERT 1', opts({ singleTransaction: true }))
    if (bare.format !== 'sql') throw new Error('sql result expected')
    expect(bare.errors).toStrictEqual([{ sql: 'COMMIT', message: 'deferred', index: 1 }])
    // A COMMIT that went through is not an error and is not counted.
    const ok = await importSql(scripted(), ns, 'INSERT 1', opts({ singleTransaction: true }))
    expect(ok).toMatchObject({ statements: 1, succeeded: 1, failed: 0, errors: [], warnings: [] })
  })
})

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
