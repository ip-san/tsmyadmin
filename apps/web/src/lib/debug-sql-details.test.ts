import { act, renderHook } from '@testing-library/react'
import { PASSWORD_MASK, type StatementResult } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDebugSql, maskSql, recordSql, recordStatement, useDebugSql } from './debug-sql.ts'

/** What the debug panel keeps and shows: masked statements, the ring, and who is told (found by mutation testing). */

describe('maskSql: a quoted password that is never closed', () => {
  it('masks everything after the opening quote when the closing one is escaped or missing', () => {
    for (const sql of [
      "ALTER USER u IDENTIFIED BY 'abc\\'def",
      "ALTER USER u IDENTIFIED BY 'abc''def",
      "ALTER USER u IDENTIFIED BY 'abc",
      'ALTER USER u IDENTIFIED BY "abc\\"def',
      'ALTER USER u IDENTIFIED BY "abc""def',
    ]) {
      const out = maskSql(sql)
      expect(out, sql).not.toContain('abc')
      expect(out, sql).not.toContain('def')
      expect(out, sql).toBe(`ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}'`)
    }
  })

  it('still masks a closed one whole, doubled quotes inside it included, and keeps what follows it', () => {
    // A backslash before a quote ends the string on PostgreSQL, not on MySQL: the panel cannot tell, so all goes.
    expect(maskSql("ALTER USER u IDENTIFIED BY 'abc\\'def' WITH x")).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}'`
    )
    expect(maskSql("ALTER USER u IDENTIFIED BY 'abc''def' WITH x")).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}' WITH x`
    )
    expect(maskSql('ALTER USER u IDENTIFIED BY "abc" WITH x')).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}' WITH x`
    )
    expect(maskSql("ALTER USER u IDENTIFIED BY '' WITH x")).toBe(`ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}' WITH x`)
    // Closed, so the span from the first quote to the last one is the mask: a second literal goes with it.
    expect(maskSql("ALTER USER u IDENTIFIED BY 'abc\\'def' more 'x'")).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}'`
    )
  })
})

describe('maskSql: a dollar-quoted password that is never closed', () => {
  it('masks everything after the opening tag, so no part of the password stays', () => {
    for (const sql of [
      'ALTER ROLE u PASSWORD $$hunter2',
      'ALTER ROLE u PASSWORD $$hunter2 more words',
      'ALTER ROLE u PASSWORD $tag$hunter2 more',
      'ALTER ROLE u PASSWORD $tag$hunter2 $other$ more',
      // A tag cannot start with a digit, so `$1` opens a run that nothing closes.
      'ALTER ROLE u PASSWORD $1',
      'ALTER ROLE u PASSWORD $1 more',
    ]) {
      const out = maskSql(sql)
      expect(out, sql).not.toContain('hunter2')
      expect(out, sql).not.toContain('more')
      expect(out, sql).toBe(`ALTER ROLE u PASSWORD '${PASSWORD_MASK}'`)
    }
  })

  it('still masks a closed one whole and keeps what follows it', () => {
    expect(maskSql('ALTER ROLE u PASSWORD $$hunter2$$')).toBe(`ALTER ROLE u PASSWORD '${PASSWORD_MASK}'`)
    expect(maskSql('ALTER ROLE u PASSWORD $tag$hunter2$tag$ VALID UNTIL x')).toBe(
      `ALTER ROLE u PASSWORD '${PASSWORD_MASK}' VALID UNTIL x`
    )
  })
})

describe('maskSql: the other forms', () => {
  it('masks a quote that is never closed from the quote on, in each kind of quote', () => {
    expect(maskSql("ALTER USER u IDENTIFIED BY 'unterminated secret")).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}'`
    )
    expect(maskSql('ALTER USER u IDENTIFIED BY "unterminated secret')).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}'`
    )
    expect(maskSql("ALTER USER u IDENTIFIED BY 'a b' WITH GRANT OPTION")).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}' WITH GRANT OPTION`
    )
    // A whole script is masked from the first keyword to its last quote: coarser than the server's split, never less.
    expect(maskSql("SET PASSWORD FOR u = 'x'\nSELECT 'tail'")).toBe(`SET PASSWORD FOR u = '${PASSWORD_MASK}'`)
  })

  it('masks a connection string password up to the next blank, quote or semicolon, anywhere in the statement', () => {
    expect(maskSql('CREATE SUBSCRIPTION s CONNECTION host=h password=secret dbname=d')).toBe(
      `CREATE SUBSCRIPTION s CONNECTION host=h password=${PASSWORD_MASK} dbname=d`
    )
    expect(maskSql('x PASSWORD = secret;')).toBe(`x PASSWORD = ${PASSWORD_MASK};`)
    expect(maskSql('SELECT 1')).toBe('SELECT 1')
  })
})

describe('the record of statements', () => {
  beforeEach(clearDebugSql)
  const entries = () => renderHook(() => useDebugSql()).result.current

  it('numbers the statements in order, stamps the time, and keeps the timing and outcome it is given', () => {
    const before = Date.now()
    recordSql('SELECT 1', 12, true)
    recordSql('SELECT 2', null, false)
    const [a, b] = entries()
    expect(b?.id).toBe((a?.id ?? 0) + 1)
    expect(a).toMatchObject({ sql: 'SELECT 1', ms: 12, ok: true, rerun: 'SELECT 1' })
    expect(b).toMatchObject({ sql: 'SELECT 2', ms: null, ok: false })
    expect(a?.at).toBeGreaterThanOrEqual(before)
    expect(a?.at).toBeLessThanOrEqual(Date.now())
  })

  it('keeps the statement to re-run apart when one is given, masked as well', () => {
    recordSql("CREATE USER u IDENTIFIED BY 'pw'", 1, true, "CREATE USER u IDENTIFIED BY 'other'")
    const [entry] = entries()
    expect(entry?.sql).toBe(`CREATE USER u IDENTIFIED BY '${PASSWORD_MASK}'`)
    expect(entry?.rerun).toBe(`CREATE USER u IDENTIFIED BY '${PASSWORD_MASK}'`)
    expect(JSON.stringify(entry)).not.toContain('other')
  })

  it('records a finished statement with its own time, and an error without one', () => {
    const results: StatementResult[] = [
      { kind: 'rows', sql: 'SELECT 1', result: { columns: [], rows: [], truncated: false }, durationMs: 7 },
      { kind: 'affected', sql: 'UPDATE t SET a = 1', affectedRows: 0, durationMs: 3 },
      { kind: 'error', sql: 'SELEC 1', message: 'x' },
    ]
    for (const r of results) recordStatement(r)
    const [rows, affected, error] = entries()
    expect(rows).toMatchObject({ sql: 'SELECT 1', ms: 7, ok: true })
    expect(affected).toMatchObject({ ms: 3, ok: true })
    expect(error).toMatchObject({ sql: 'SELEC 1', ms: null, ok: false })
  })

  it('tells those who listen when a statement is noted or the record is cleared', () => {
    let renders = 0
    const hook = renderHook(() => {
      renders++
      return useDebugSql()
    })
    expect(hook.result.current).toHaveLength(0)
    const first = renders
    act(() => recordSql('SELECT 1', 1, true))
    expect(hook.result.current).toHaveLength(1)
    expect(renders).toBeGreaterThan(first)
    const second = renders
    act(() => clearDebugSql())
    expect(hook.result.current).toHaveLength(0)
    expect(renders).toBeGreaterThan(second)
  })
})
