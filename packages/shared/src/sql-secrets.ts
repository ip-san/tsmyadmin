import { PASSWORD_MASK } from './schemas/users.ts'

/**
 * Masking the password of an account statement, shared by the server's audit log and the browser's debug panel so
 * the two never drift apart again (every leak found in one had to be fixed in the other as well).
 *
 * The rule: from the first IDENTIFIED / PASSWORD keyword on, everything from the first quote-like character to the
 * end of the last literal is one mask, so nested quoting (`''secret''`) cannot leave a fragment outside a literal; as
 * soon as one quote-like character does not start a complete literal — a string never closed (an escaped or doubled
 * last quote, a `$` tag that is not repeated), wherever it stands, after closed ones too (`BY 'new' REPLACE 'old`) —
 * the mask runs to the end of the statement, however many quotes the rest holds. The account name before the keyword
 * stays, and so does the tail after a closed literal (`WITH GRANT OPTION`), unless a comment opens among the
 * literals (its quotes would pair with theirs): the mask then starts at the comment, or runs on to the end. A password
 * inside a connection string (`password=…`) or URL (`scheme://user:…@host`) is masked on its own, keyword or not.
 */

/**
 * A SQL string literal: plain / doubled-quote / backslash-escaped, PostgreSQL `E'…'`, or dollar-quoted `$tag$…$tag$`.
 * `n` is the index the dollar tag capture group will have inside the enclosing pattern. With `whole`, a quote right
 * after the closing one is read as a doubled quote, not as the end: `'abc''def` is then one string that never closes.
 * `whole` also refuses a backslash before the quote: MySQL reads `\'` as an escaped quote, PostgreSQL's standard
 * strings as a backslash and the end (`'a\''secret`), so a literal whose end depends on the server is not complete.
 */
export const sqlLiteralPattern = (n: number, whole = false): string =>
  `(?:(?:[EeNnXxBb]|[Uu]&|_[A-Za-z0-9]+)?'(?:[^'\\\\]|\\\\${whole ? "[^']" : '[\\s\\S]'}|'')*'${whole ? "(?!')" : ''}|"(?:[^"\\\\]|\\\\${whole ? '[^"]' : '[\\s\\S]'}|"")*"${whole ? '(?!")' : ''}|\\$((?:[A-Za-z_\\u0080-\\uffff][\\w\\u0080-\\uffff]*)?)\\$[\\s\\S]*?\\$\\${n}\\$)`

/**
 * `password=secret` inside a connection string (CREATE SUBSCRIPTION … CONNECTION, dblink, postgres_fdw options). libpq
 * reads a backslash as escaping the next character (`password=a\ b` is `a b`), so an escaped space does not end it.
 */
const CONNECTION_PASSWORD = /(\bpassword\s*=\s*)(?:\\[\s\S]|[^\s'";\\])+/gi
/**
 * `scheme://user:secret@host` (a libpq URI in CREATE SUBSCRIPTION / dblink, a MySQL FEDERATED table's CONNECTION):
 * up to the last `@`, so an unencoded `@` or `/` in the password hides more, not less.
 */
const CONNECTION_URL_PASSWORD = /(\b[A-Za-z][\w+.-]*:\/\/[^\s'"/@:]*:)[^\s'"]+(?=@)/g
/** A statement's credential part: the text up to and including the first keyword, and all that follows it. */
const CREDENTIAL_PART = /^([\s\S]*?\b(?:\w+_)?(?:IDENTIFIED|PASSWORD)\b)([\s\S]*)$/i
/**
 * Where a literal or a comment may start: a comment between literals hides how its quotes pair up. Read for either
 * server (`#` is PostgreSQL's XOR, `--` without a space MySQL's minus twice): taken for a comment, it hides more.
 */
const LITERAL_OR_COMMENT = /['"$]|\/\*|--|#/g
const LITERAL_AT = new RegExp(sqlLiteralPattern(1, true), 'y')

/** The next quote-like character or comment opener at or after `from`, or -1. */
function nextLiteralOrComment(text: string, from: number): number {
  LITERAL_OR_COMMENT.lastIndex = from
  return LITERAL_OR_COMMENT.exec(text)?.index ?? -1
}

/**
 * Where the mask that starts at `first` ends: after the last of the literals that follow one another from there, or
 * at the end of the text as soon as a quote-like character does not start a complete literal, or a comment opens
 * outside one (`/* it's *\/ 'secret` would otherwise pair the comment's quote with the password's opening one).
 */
function maskEnd(text: string, first: number): number {
  let end = first
  for (let at = first; at !== -1; ) {
    LITERAL_AT.lastIndex = at
    if (!/['"$]/.test(text[at] ?? '') || !LITERAL_AT.test(text)) return text.length
    end = LITERAL_AT.lastIndex
    at = nextLiteralOrComment(text, end)
  }
  return end
}

/** `password=secret` in a connection string and `user:secret@` in a connection URL, masked. */
export function maskConnectionPassword(sql: string): string {
  return sql
    .replace(CONNECTION_PASSWORD, (_m, head: string) => `${head}${PASSWORD_MASK}`)
    .replace(CONNECTION_URL_PASSWORD, (_m, head: string) => `${head}${PASSWORD_MASK}`)
}

/**
 * One statement with its credential part masked as described above. Given a whole script instead of one statement,
 * it masks from the first keyword to the last literal of the script (or to its end): coarser, never finer.
 */
export function maskCredentialPart(statement: string): string {
  const m = CREDENTIAL_PART.exec(statement)
  if (!m) return statement
  const tail = m[2] ?? ''
  if (!/['"$]/.test(tail)) return statement
  const first = nextLiteralOrComment(tail, 0)
  return `${m[1]}${tail.slice(0, first)}'${PASSWORD_MASK}'${tail.slice(maskEnd(tail, first))}`
}
