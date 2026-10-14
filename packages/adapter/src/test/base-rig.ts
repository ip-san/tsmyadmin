import type { TableSchema } from '@tsmyadmin/shared'
import { type Mock, vi } from 'vitest'
import type { Conn, RawResult } from '../driver.ts'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'
import { type Answer, rows } from './scripted-conn.ts'

/**
 * A real adapter of either dialect whose pooled connections are faked at `acquire`, the one seam the base shares:
 * a test sees every statement a server would, the session ones (the statement timeout, BEGIN / COMMIT / ROLLBACK)
 * included, each answered from a script. `sent` keeps them all; `asked` leaves the session ones out, so a test
 * about a statement indexes the statement.
 */

export type Dialect = 'mysql' | 'postgres'
export const ns = { database: 'd', schema: 'sales' }

interface Asked {
  text: string
  params: unknown[] | undefined
}
/** The answer of the first rule matching a statement, or of a function (`undefined` to fall through). */
type Rules = [RegExp, Answer][] | ((text: string, params?: unknown[]) => Answer | Promise<RawResult> | undefined)
/** The parts of a table's description a test cares about; the rest is filled in. */
type TableParts = Partial<Omit<TableSchema, 'columns'>> & {
  columns?: { name: string; dataType: string; nullable?: boolean }[]
}
interface Options {
  rules?: Rules
  /** How many pooled connections the adapter hands out in turn (the last one repeats). */
  conns?: number
  /** What `describeTable` answers, for every table or by name. */
  table?: TableParts | ((table: string) => TableParts)
}
type FakeConn = Conn & { release: Mock; forget: Mock; reset: Mock; discard: Mock; query: Mock }

/** A result that changed `n` rows. */
export const affecting = (n: number): RawResult => ({ ...rows([]), affectedRows: n })
/** A column with its fields spelled out. */
export const column = (name: string, dataType = 'varchar(20)', nullable = false) => ({ name, dataType, nullable })

/** The statements the base sends around the ones a test asks for; answered with nothing unless a rule says otherwise. */
const SESSION = /^(?:BEGIN|COMMIT|ROLLBACK|SET SESSION max_execution_time = \d+|SET statement_timeout = \d+)$/
const TIMEOUT = /^SET (?:SESSION max_execution_time|statement_timeout) = (\d+)$/
const TABLE: Omit<TableSchema, 'name'> = {
  kind: 'table',
  comment: null,
  engine: null,
  rowEstimate: null,
  partitioned: false,
  hasChildren: false,
  inherits: [],
  collation: null,
  autoIncrement: null,
  columns: [],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
}

export function rig(dialect: Dialect, options: Options = {}) {
  const cfg = { dialect, host: 'h', port: 1, user: 'u', password: 'p' } as const
  const adapter = dialect === 'mysql' ? new MysqlAdapter(cfg) : new PostgresAdapter(cfg)
  const sent: Asked[] = []
  const asked: Asked[] = []
  const { rules = [], table } = options
  const answer = (text: string, params?: unknown[]) => {
    const found = typeof rules === 'function' ? rules(text, params) : rules.find(([p]) => p.test(text))?.[1]
    if (found !== undefined) return found
    if (SESSION.test(text)) return rows([])
    throw new Error(`unscripted statement: ${text}`)
  }
  const conns = Array.from({ length: options.conns ?? 1 }, (_, n) => {
    const conn = {
      id: { n },
      release: vi.fn(),
      forget: vi.fn(),
      reset: vi.fn(async () => undefined),
      discard: vi.fn(),
      query: vi.fn(async (text: string, params?: unknown[]) => {
        const q = { text, params }
        sent.push(q)
        if (!SESSION.test(text)) asked.push(q)
        const out = answer(text, params)
        if (out instanceof Error) throw out
        return out
      }),
    }
    return conn as unknown as FakeConn
  })
  let next = 0
  const internals = adapter as unknown as { acquire: unknown; describeTable: unknown; openCanceller: unknown }
  internals.acquire = async () => conns[Math.min(next++, conns.length - 1)]
  if (table) {
    internals.describeTable = async (_ns: unknown, name: string) =>
      ({ ...TABLE, name, ...(typeof table === 'function' ? table(name) : table) }) as unknown as TableSchema
  }
  const canceller = { cancel: vi.fn(async (_id: string) => undefined), close: vi.fn(async () => undefined) }
  internals.openCanceller = async () => canceller
  return {
    adapter,
    sent,
    asked,
    conns,
    conn: conns[0] as FakeConn,
    canceller,
    /** Every statement sent, in order. */
    statements: () => sent.map((q) => q.text),
    /** The statement timeouts set, in order (each one sent, whether or not the server took it). */
    timeouts: () =>
      sent
        .map((q) => TIMEOUT.exec(q.text)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number),
    /** How many transactions were begun. */
    transactions: () => sent.filter((q) => q.text === 'BEGIN').length,
  }
}
