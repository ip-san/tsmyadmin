/** What both servers' EXPLAIN takes from the SQL tab, and what comes back. */
import { type Dialect, EXPLAIN_RAW_MAX, EXPLAINABLE, type ExplainResult, type PlanNode } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'
import { isPlainRead } from './read-wrap.ts'
import { splitStatements, stripLeadingComments } from './split.ts'

/**
 * The one statement of `sql` to explain, without its leading comments. Refused (`VALIDATION`): more than one
 * statement (the text is appended to EXPLAIN, and a second statement would run as itself), and anything EXPLAIN does
 * not take, which includes an EXPLAIN or ANALYZE (an ANALYZE runs the statement).
 */
export function explainableStatement(sql: string, dialect: Dialect): string {
  const statements = splitStatements(sql, dialect)
  const [only] = statements
  if (statements.length !== 1 || !only) throw new AdapterError('VALIDATION', 'Only one statement can be explained')
  const text = stripLeadingComments(only.sql, dialect).trim()
  if (!EXPLAINABLE.test(text)) {
    throw new AdapterError('VALIDATION', 'Only SELECT, INSERT, UPDATE, DELETE, REPLACE, TABLE and VALUES are explained')
  }
  return text
}

/**
 * The one statement of `sql` to run for its measured plan: as `explainableStatement`, and a plain read besides
 * (`isPlainRead`). A write is refused even though it would be rolled back: a sequence, a trigger's side effect or a
 * lock outlives the rollback. So are a locking read and an INTO (a file, a variable); MySQL refuses more
 * (`measurableMysqlStatement`). What a read leaves on its session (a named or advisory lock) the adapter undoes by resetting it.
 */
export function measurableStatement(sql: string, dialect: Dialect): string {
  const text = explainableStatement(sql, dialect)
  if (!isPlainRead(text, dialect)) {
    throw new AdapterError(
      'VALIDATION',
      'Only a read (SELECT, TABLE, VALUES) that locks and stores nothing is measured'
    )
  }
  return text
}

/** The plan read from what the server answered, which comes as text or (by driver) already parsed. */
export function explainResult(plan: PlanNode, raw: unknown, measured?: { ms: number | null }): ExplainResult {
  const text = JSON.stringify(raw, null, 2) ?? ''
  return {
    plan,
    raw: text.slice(0, EXPLAIN_RAW_MAX),
    rawTruncated: text.length > EXPLAIN_RAW_MAX,
    ...(measured ? { measured } : {}),
  }
}

export const parseJsonCell = (cell: unknown): unknown => (typeof cell === 'string' ? JSON.parse(cell) : cell)
