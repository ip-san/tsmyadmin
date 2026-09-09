import type { Dialect } from '@tsmyadmin/shared'
import { stripLeadingComments } from './split.ts'

const BEGINS = /^(?:START\s+TRANSACTION|BEGIN)\b/i
const ENDS = /^(?:COMMIT|ROLLBACK)\b(?!\s+TO\b)/i
const AUTOCOMMIT = /^SET\b[\s\S]*?\bautocommit\s*=\s*(\d|ON|OFF|TRUE|FALSE)\b/i
const WRITES = /^(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|SELECT|WITH|TABLE|VALUES|CALL|DO)\b/i
/** MySQL commits the open transaction before and after each of these; PostgreSQL runs them transactionally. */
const MYSQL_IMPLICIT_COMMIT =
  /^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|GRANT|REVOKE|FLUSH|LOCK|UNLOCK|ANALYZE|OPTIMIZE|REPAIR|INSTALL|UNINSTALL)\b/i

/**
 * Whether a script leaves a transaction open at its end. Each run is autocommitted on its own pooled connection,
 * so anything still open is rolled back when the run finishes — silently, unless the caller says so.
 *
 * Judged from the statements that actually ran (a `BEGIN` after a stop-on-error never opened anything). MySQL's
 * implicit commits are modelled; a `BEGIN` inside a routine body is not a concern because the splitter keeps a
 * routine in one statement, whose first keyword is CREATE.
 */
export function leavesTransactionOpen(statements: readonly string[], dialect: Dialect): boolean {
  let open = false
  let autocommitOff = false
  for (const raw of statements) {
    const sql = stripLeadingComments(raw, dialect).trimStart()
    const off = AUTOCOMMIT.exec(sql)
    if (off) {
      autocommitOff = /^(?:0|OFF|FALSE)$/i.test(off[1] ?? '')
      // Turning autocommit back on commits whatever was open.
      if (!autocommitOff) open = false
      continue
    }
    if (BEGINS.test(sql)) {
      open = true
      continue
    }
    if (ENDS.test(sql)) {
      open = false
      continue
    }
    if (dialect === 'mysql' && MYSQL_IMPLICIT_COMMIT.test(sql)) {
      open = false
      continue
    }
    if (autocommitOff && WRITES.test(sql)) open = true
  }
  return open
}
