import type { Dialect } from '@tsmyadmin/shared'
import { stripLeadingComments } from './split.ts'

const BEGINS = /^(?:START\s+TRANSACTION|BEGIN)\b/i
const ENDS = /^(?:COMMIT|ROLLBACK)\b(?!\s+TO\b)/i
// `@autocommit` is a user variable and means nothing; `@@autocommit` and `@@session.autocommit` do.
const AUTOCOMMIT =
  /^SET\b[\s\S]*?(?:(?<![@\w.])autocommit|@@(?:session\.|global\.|local\.)?autocommit)\s*=\s*(\d+|ON|OFF|TRUE|FALSE)\b/i
const WRITES = /^(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|SELECT|WITH|TABLE|VALUES|CALL|DO)\b/i
/** MySQL commits the open transaction before and after each of these; PostgreSQL runs them transactionally. */
const MYSQL_IMPLICIT_COMMIT =
  /^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|GRANT|REVOKE|FLUSH|LOCK|UNLOCK|ANALYZE|OPTIMIZE|REPAIR|INSTALL|UNINSTALL)\b/i
/** The documented exception: a temporary table is created and dropped inside the transaction. */
const MYSQL_TEMPORARY = /^(?:CREATE|DROP)\s+TEMPORARY\b/i
/** `COMMIT AND CHAIN` ends the transaction and immediately starts the next one. */
const AND_CHAIN = /\bAND\s+CHAIN\b/i

/**
 * Whether a script leaves a transaction open at its end. Each run is autocommitted on its own pooled connection,
 * so anything still open is rolled back when the run finishes — silently, unless the caller says so.
 *
 * Judged from the statements that actually ran (a `BEGIN` after a stop-on-error never opened anything). MySQL's
 * implicit commits are modelled; a `BEGIN` inside a routine body is not a concern because the splitter keeps a
 * routine in one statement, whose first keyword is CREATE.
 */
export function leavesTransactionOpen(statements: readonly ExecutedStatement[], dialect: Dialect): boolean {
  let open = false
  let autocommitOff = false
  for (const { sql: raw, failed, nativeCode } of statements) {
    const sql = stripLeadingComments(raw, dialect).trimStart()
    // A MySQL DDL commits even when it fails, because the implicit commit happens before the statement runs —
    // unless the server could not parse it, in which case nothing ran. A `BEGIN` or `SET autocommit` that
    // errored changed nothing either, hence the `failed` check below.
    const parsed = !(failed && nativeCode === 'ER_PARSE_ERROR')
    if (parsed && dialect === 'mysql' && MYSQL_IMPLICIT_COMMIT.test(sql) && !MYSQL_TEMPORARY.test(sql)) {
      open = false
      continue
    }
    if (failed) continue
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
      // `COMMIT AND CHAIN` closes and reopens in one statement.
      open = AND_CHAIN.test(sql)
      continue
    }
    if (autocommitOff && WRITES.test(sql)) open = true
  }
  return open
}

/** One statement the script actually ran. A failed statement did not open or close a transaction. */
export interface ExecutedStatement {
  sql: string
  failed?: boolean
  /** Dialect error code (`ER_PARSE_ERROR`, a PostgreSQL SQLSTATE): tells a rejected statement from a failed one. */
  nativeCode?: string | undefined
}
