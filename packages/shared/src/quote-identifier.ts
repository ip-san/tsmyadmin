import { capabilities } from './capabilities.ts'
import type { Dialect } from './schemas/dialect.ts'

/**
 * A name as an identifier in SQL text for this server: wrapped in its quote character, the quote character inside it
 * doubled (MySQL: backticks, PostgreSQL: double quotes). The one place this is written: the adapter's `quoteIdent`
 * (which also refuses a NUL byte) and the screens that show SQL a person reads or edits both go through it.
 */
export function quoteIdentifier(dialect: Dialect, name: string): string {
  const q = capabilities(dialect).identifierQuote
  return `${q}${name.replaceAll(q, q + q)}${q}`
}

/**
 * A text as a single-quoted SQL string literal for this server: the quote doubled, and on MySQL the backslash too (it
 * is an escape there). Never put a value into SQL any other way; the adapter binds values as parameters, and this is for
 * the places that must write the text out (a dump, a statement shown to a person, a COMMENT).
 */
export function quoteLiteral(dialect: Dialect, value: string): string {
  const text = capabilities(dialect).literalBackslashEscapes ? value.replaceAll('\\', '\\\\') : value
  return `'${text.replaceAll("'", "''")}'`
}
