import { splitStatements } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import type { StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { caught } from '../test/caught.ts'
import { ns, opts, scripted } from '../test/import-sql-harness.ts'
import { decodeUpload, type ImportSqlOptions, ImportValidationError, importSql } from './import.ts'

/**
 * The import: the upload, the header, the script that is sent, the progress, the counts and the errors (the
 * warnings are in import-warnings-details.test.ts).
 */

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
    // Lines after the bad byte are not counted.
    const third = caught([0x61, 0x0a, 0x62, 0x0a, 0xff, 0x0a, 0x63, 0x0a, 0x64])
    expect(third?.message).toBe('The file is not valid UTF-8 (near line 3)')
    expect(third?.params).toEqual({ line: 3 })
  })

  it('reads UTF-8 as it is, a byte-order mark included', () => {
    expect(decodeUpload(new TextEncoder().encode('日本語\nabc'))).toBe('日本語\nabc')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// SQL

const lastOptions = (a: FakeAdapter) => a.calls.at(-1)?.args[2] as Record<string, unknown>
const lastScript = (a: FakeAdapter) => a.calls.at(-1)?.args[1] as string
const sent = (a: FakeAdapter) => (lastOptions(a).statements as { sql: string; line: number }[]) ?? []
const caughtOf = (p: Promise<unknown>) => caught<ImportValidationError>(p)

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
    for (const text of [
      '-- Dialect: mysql\nSELECT 1;',
      'SELECT 1;\n-- MySQL dump\nSELECT 2;',
      'SELECT 1; -- Dialect: postgres',
      '-- Dialect: postgresql-ish\nSELECT 1;',
    ]) {
      await expect(importSql(a, ns, text, opts()), text).resolves.toMatchObject({ format: 'sql', failed: 0 })
    }
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
    if (r.format !== 'sql') throw new Error('sql result expected')
    expect(r.total).toBe(4)
    const none = scripted()
    await importSql(none, ns, text, opts({ skip: 0 }))
    expect(sent(none)).toHaveLength(8)
  })

  it('does not keep a skipped statement that only has SET or USE inside it', async () => {
    const a = scripted()
    await importSql(
      a,
      ns,
      'UPDATE t SET a = 1;\nINSERT INTO t VALUES (1);\nINSERT INTO uses VALUES (2)',
      opts({ skip: 2 })
    )
    expect(sent(a).map((s) => s.sql)).toEqual(['INSERT INTO uses VALUES (2)'])
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
