/**
 * The row cap of the SQL console for PostgreSQL: a plain read is run as a subquery with a LIMIT.
 * (MySQL sets `sql_select_limit` for the script instead; see `capResultRows` in mysql/adapter.ts.)
 */
import type { Dialect } from '@tsmyadmin/shared'
import { stripLeadingComments } from './split.ts'

const READ_START = /^\s*(?:\(|(?:SELECT|WITH|VALUES|TABLE)\b)/i
const NOT_WRAPPABLE =
  /\b(?:INTO|FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|LOCK\s+IN\s+SHARE\s+MODE|INSERT|UPDATE|DELETE|MERGE)\b/i
/** String literals, quoted identifiers, dollar-quoted bodies and comments, replaced by a space (`'delete'` is data, not DML). */
const LITERALS_AND_COMMENTS =
  /\bE'(?:[^'\\]|\\.|'')*'|'(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g

const LITERALS_AND_COMMENTS_STANDARD =
  /\bE'(?:[^'\\]|\\.|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1|--[^\n]*|\/\*[\s\S]*?\*\//g

/** Backslashes escape quotes in MySQL strings; in PostgreSQL only inside E'...' (standard_conforming_strings). */
export function stripLiterals(code: string, dialect: Dialect): string {
  return code.replace(dialect === 'mysql' ? LITERALS_AND_COMMENTS : LITERALS_AND_COMMENTS_STANDARD, ' ')
}

export const WRAP_PREFIX = 'SELECT * FROM (\n'

/**
 * Subquery form of a plain read with a row cap, or null when the statement must run as written. The body is
 * placed on its own line so a trailing `--` comment cannot swallow the closing parenthesis; data-modifying
 * statements (also inside a WITH) are never wrapped.
 */
export function wrapReadOnly(sql: string, limit: number, dialect: Dialect = 'postgres'): string | null {
  const body = sql.trim().replace(/;+\s*$/, '')
  // Leading comments stay in the text the user sees, but do not count when deciding whether this is a read.
  const code = stripLeadingComments(body, dialect)
  if (!READ_START.test(code) || NOT_WRAPPABLE.test(stripLiterals(code, dialect))) return null
  return `${WRAP_PREFIX}${body}\n) AS _tsmyadmin LIMIT ${Math.max(1, Math.floor(limit))}`
}
