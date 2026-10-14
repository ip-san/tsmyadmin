import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import type { StatementResult } from '@tsmyadmin/shared'
import type { ImportSqlOptions } from '../lib/import.ts'

/** A fake server for the SQL import tests: scripted answers, statement by statement, and the default options. */

export const ns = { database: 'shop' }
export const opts = (over: Partial<ImportSqlOptions> = {}): ImportSqlOptions => ({
  stopOnError: true,
  ignoreForeignKeys: false,
  singleTransaction: false,
  queryId: 'q',
  ...over,
})

export type Fail = { message: string; code?: 'QUERY_FAILED'; nativeCode?: string }

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
export const scripted = (
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
