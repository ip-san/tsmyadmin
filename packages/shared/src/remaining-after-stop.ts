import type { StatementResult } from './schemas/result.ts'

const BEGIN = /^\s*(?:BEGIN|START\s+TRANSACTION)\s*$/i
const END = /^\s*(?:COMMIT|END)\s*$/i

/**
 * The statements of a stopped script still to run, from the results it gave back: from the statement the stop cut
 * short (it did not take effect), or after the last one that ended. A transaction the script began and did not commit
 * was rolled back when it stopped, so the rest starts again at its BEGIN (the transactions DDL scripts write are
 * PostgreSQL's, where DDL is transactional; MySQL's DDL commits on its own). Null where the results cannot be matched to
 * the statements (a result without its position, or of another statement), or the stop cut a COMMIT short: what ran
 * is not known.
 */
export function remainingAfterStop(sql: readonly string[], results: readonly StatementResult[]): string[] | null {
  let resume = 0
  for (const r of results) {
    const at = r.statement
    if (at === undefined || sql[at]?.trim() !== r.sql.trim()) return null
    if (r.kind === 'error') {
      // Cut short on its COMMIT, a transaction may have committed before the stop reached it: not known.
      if (END.test(sql[at] ?? '')) return null
      resume = at
      break
    }
    resume = Math.max(resume, at + 1)
  }
  let open: number | null = null
  for (const [i, s] of sql.slice(0, resume).entries()) {
    if (BEGIN.test(s)) open = i
    else if (END.test(s)) open = null
  }
  return sql.slice(open ?? resume)
}
