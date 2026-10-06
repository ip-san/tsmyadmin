import { vi } from 'vitest'
import type { Conn, RawResult } from '../driver.ts'
import { AdapterError } from '../types.ts'

/** A result with `data` as its rows (and `names` as the columns). */
export const rows = (data: unknown[][], names: string[] = []): RawResult => ({
  columns: names.map((name) => ({ name }) as RawResult['columns'][number]),
  rows: data as RawResult['rows'],
  affectedRows: 0,
  hasRows: true,
})

/** An error as the adapter reports one: `nativeCode` is the server's own code. */
export const fail = (code: string, nativeCode?: string) =>
  new AdapterError(
    code as 'QUERY_FAILED',
    `${nativeCode ?? code}: scripted`,
    'scripted',
    nativeCode ? { nativeCode } : {}
  )

export type Answer = RawResult | Error

/**
 * A connection that answers each statement from the first rule whose pattern matches it, and keeps what it was asked.
 * For the branches that depend on what a server answers, which a real one gives in only one way (the fixtures have no
 * pg_stat_statements, the test account may read everything, a routine has the shape the fixture gave it).
 */
export function scripted(rules: [RegExp, Answer][]) {
  const asked: { text: string; params: unknown[] | undefined }[] = []
  const discard = vi.fn()
  const conn = {
    id: {},
    release: () => undefined,
    reset: async () => undefined,
    forget: () => undefined,
    discard,
    async query(text: string, params?: unknown[]) {
      asked.push({ text, params })
      const rule = rules.find(([pattern]) => pattern.test(text))
      if (!rule) throw new Error(`unscripted statement: ${text}`)
      if (rule[1] instanceof Error) throw rule[1]
      return rule[1]
    },
  } satisfies Conn
  return { conn, asked, discard }
}
