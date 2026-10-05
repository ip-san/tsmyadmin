import { ROW_FUNCTIONS, ROW_FUNCTIONS_WITH_ARG, type RowFunction, rowFunctionsFor } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { rowFunctionSql } from './row-functions.ts'

/** The SQL of every allowed row function, per dialect (`?` / `$1` stand for the bound argument). */
const MYSQL: Record<RowFunction, string> = {
  now: 'NOW()',
  current_date: 'CURRENT_DATE',
  current_time: 'CURRENT_TIME',
  uuid: 'UUID()',
  md5: 'MD5(?)',
  sha1: 'SHA1(?)',
  sha256: 'SHA2(?, 256)',
  upper: 'UPPER(?)',
  lower: 'LOWER(?)',
  trim: 'TRIM(?)',
}
const POSTGRES: Record<Exclude<RowFunction, 'sha1'>, string> = {
  now: 'now()',
  current_date: 'CURRENT_DATE',
  current_time: 'CURRENT_TIME',
  uuid: 'gen_random_uuid()',
  md5: 'md5($1::text)',
  sha256: "encode(sha256(convert_to($1::text, 'UTF8')), 'hex')",
  upper: 'upper($1::text)',
  lower: 'lower($1::text)',
  trim: 'btrim($1::text)',
}

/** Renders `fn`, and says what the renderer asked for: the placeholders it took. */
function render(dialect: 'mysql' | 'postgres', fn: RowFunction) {
  const taken: string[] = []
  const sql = rowFunctionSql(dialect, fn, () => {
    const placeholder = dialect === 'mysql' ? '?' : `$${taken.length + 1}`
    taken.push(placeholder)
    return placeholder
  })
  return { sql, taken }
}

describe('rowFunctionSql', () => {
  it('has the SQL of every function the schema allows, for MySQL', () => {
    expect(Object.keys(MYSQL).sort()).toEqual([...ROW_FUNCTIONS].sort())
    for (const fn of ROW_FUNCTIONS) expect(render('mysql', fn).sql, fn).toBe(MYSQL[fn])
  })

  it('has the SQL of every function the schema allows, for PostgreSQL, but SHA-1', () => {
    for (const fn of rowFunctionsFor('postgres'))
      expect(render('postgres', fn).sql, fn).toBe(POSTGRES[fn as keyof typeof POSTGRES])
  })

  it('refuses SHA-1 on PostgreSQL (no pgcrypto) rather than writing something else', () => {
    expect(() => render('postgres', 'sha1')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }))
    expect(rowFunctionsFor('postgres')).not.toContain('sha1')
  })

  it('takes a placeholder exactly for the functions that have an argument', () => {
    // A function without an argument must not take a placeholder: a spare value in the parameter list shifts every
    // value after it, and the statement is then wrong without any error.
    for (const dialect of ['mysql', 'postgres'] as const) {
      for (const fn of rowFunctionsFor(dialect)) {
        const { taken } = render(dialect, fn)
        expect(taken, `${dialect} ${fn}`).toHaveLength(ROW_FUNCTIONS_WITH_ARG.has(fn) ? 1 : 0)
      }
    }
  })

  it('never writes the argument into the SQL: only the placeholder', () => {
    for (const fn of ROW_FUNCTIONS_WITH_ARG) {
      const sql = rowFunctionSql('mysql', fn, () => '?')
      expect(sql).not.toMatch(/['"]/)
    }
  })
})
