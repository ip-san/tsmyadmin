import { PASSWORD_MASK } from './schemas/users.ts'

/**
 * Masking the password of an account statement, shared by the server's audit log and the browser's debug panel so
 * the two never drift apart again (every leak found in one had to be fixed in the other as well).
 *
 * The rule: from the first IDENTIFIED / PASSWORD keyword on, everything between the first and the last quote-like
 * character is one mask, so nested quoting (`''secret''`) cannot leave a fragment outside a literal; a string that is
 * never closed (an escaped or doubled last quote, a `$` tag that is not repeated) is masked to the end of the
 * statement, however many quotes the rest holds. The account name before the keyword stays, and so does the tail
 * after a closed literal (`WITH GRANT OPTION`).
 */

/**
 * A SQL string literal: plain / doubled-quote / backslash-escaped, PostgreSQL `E'…'`, or dollar-quoted `$tag$…$tag$`.
 * `n` is the index the dollar tag capture group will have inside the enclosing pattern. With `whole`, a quote right
 * after the closing one is read as a doubled quote, not as the end: `'abc''def` is then one string that never closes.
 */
export const sqlLiteralPattern = (n: number, whole = false): string =>
  `(?:(?:[EeNnXxBb]|[Uu]&|_[A-Za-z0-9]+)?'(?:[^'\\\\]|\\\\[\\s\\S]|'')*'${whole ? "(?!')" : ''}|"(?:[^"\\\\]|\\\\[\\s\\S]|"")*"${whole ? '(?!")' : ''}|\\$((?:[A-Za-z_\\u0080-\\uffff][\\w\\u0080-\\uffff]*)?)\\$[\\s\\S]*?\\$\\${n}\\$)`

/** `password=secret` inside a connection string (CREATE SUBSCRIPTION … CONNECTION, dblink, postgres_fdw options). */
const CONNECTION_PASSWORD = /(\bpassword\s*=\s*)[^\s'";]+/gi
/** A statement's credential part: the text up to and including the first keyword, and all that follows it. */
const CREDENTIAL_PART = /^([\s\S]*?\b(?:\w+_)?(?:IDENTIFIED|PASSWORD)\b)([\s\S]*)$/i
const QUOTED_SPAN = /['"$][\s\S]*['"$]/
const LITERAL_AT = new RegExp(sqlLiteralPattern(1, true), 'y')

/** Whether a complete string literal starts at `at` (the position of a quote-like character). */
function literalCompleteAt(text: string, at: number): boolean {
  LITERAL_AT.lastIndex = at
  return LITERAL_AT.test(text)
}

/** `password=secret` in a connection string, masked. */
export function maskConnectionPassword(sql: string): string {
  return sql.replace(CONNECTION_PASSWORD, (_m, head: string) => `${head}${PASSWORD_MASK}`)
}

/**
 * One statement with its credential part masked as described above. Given a whole script instead of one statement,
 * it masks from the first keyword to the last quote of the script: coarser, never finer.
 */
export function maskCredentialPart(statement: string): string {
  const m = CREDENTIAL_PART.exec(statement)
  if (!m) return statement
  const tail = m[2] ?? ''
  const first = tail.search(/['"$]/)
  if (first === -1) return statement
  const unclosed = !literalCompleteAt(tail, first)
  const masked =
    QUOTED_SPAN.test(tail) && !unclosed
      ? tail.replace(QUOTED_SPAN, `'${PASSWORD_MASK}'`)
      : tail.replace(/['"$][\s\S]*$/, `'${PASSWORD_MASK}'`)
  return `${m[1]}${masked}`
}
