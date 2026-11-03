import type { StatementResult } from './schemas/result.ts'

const BEGIN = /^\s*(?:BEGIN|START\s+TRANSACTION)\s*$/i
const END = /^\s*(?:COMMIT|END)\s*$/i
/** PostgreSQL's build that does not stop writes: cut short, it leaves an unusable index of its name behind. */
const CONCURRENT_BUILD = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i

/**
 * The statements of a stopped script still to run, from the results it gave back: from the statement the stop cut
 * short (it did not take effect), or after the last one that ended. A transaction the script began and did not commit
 * was rolled back when it stopped, so the rest starts again at its BEGIN (the transactions DDL scripts write are
 * PostgreSQL's, where DDL is transactional; MySQL's DDL commits on its own). Null where the results cannot be matched to
 * the statements (a result without its position, or of another statement), or the stop cut a COMMIT short: what ran
 * is not known. Null too where it cut short a build that does not stop writes: the index it leaves behind makes the
 * same statement fail, so the operation is previewed again (which drops that index first) rather than its rest run.
 */
export function remainingAfterStop(sql: readonly string[], results: readonly StatementResult[]): string[] | null {
  let resume = 0
  for (const r of results) {
    const at = r.statement
    if (at === undefined || sql[at]?.trim() !== r.sql.trim()) return null
    if (r.kind === 'error') {
      // Cut short on its COMMIT, a transaction may have committed before the stop reached it: not known.
      if (END.test(sql[at] ?? '') || CONCURRENT_BUILD.test(sql[at] ?? '')) return null
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
