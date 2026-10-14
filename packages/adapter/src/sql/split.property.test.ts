import type { Dialect } from '@tsmyadmin/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { lexicalRules } from './lexical-rules.ts'
import { countStatements, splitStatements, stripComments } from './split.ts'

/**
 * Properties of the splitter, for both servers: scripts are built from tokens the server reads one way only (code,
 * literals and comments that hold `;`, quotes, comment openers and `$` tags inside), so the statements that went in
 * are the statements that must come out. The audit log's redaction splits with it, so a wrong split is a leak.
 */

const DIALECTS = ['mysql', 'postgres'] as const
const params = { seed: 20261014, numRuns: 1000 }

/** Characters that end, open or escape something somewhere: what goes inside literals and comments. */
const INNER = fc.constantFrom(
  "'",
  '"',
  '`',
  '\\',
  ';',
  '$',
  '$$',
  '$t$',
  '\n',
  '\r\n',
  '-- ',
  '#',
  '/*',
  '*/',
  '/*!',
  'DELIMITER //',
  'BEGIN ATOMIC',
  'END',
  ' ',
  'a',
  'é',
  '🔑'
)
const inner = fc.array(INNER, { maxLength: 6 }).map((parts) => parts.join(''))

/** Plain code: never a statement of its own kind (SET, DELIMITER, COPY, BEGIN ATOMIC are left to the examples). */
const CODE = ['SELECT', 'x', '1', '+', '(', ')', ',', 'FROM', 't', '.', '=', '*', 'a_b', 'a$b$', 'x$', '2-1', 'CASE']

/**
 * An unquoted identifier as both servers read it: a letter, `_` or any non-ASCII character first, then also digits
 * and `$` (PostgreSQL's `ident_start` / `ident_cont`). So `é$t$` is one name, not `é` and a dollar tag. It never
 * spells BEGIN, CASE or END. MySQL takes non-ASCII only up to U+FFFF, so the emoji is PostgreSQL's.
 */
function identifier(dialect: Dialect): fc.Arbitrary<string> {
  const rest = ['a', '1', '_', '$', '$t$', '$$', 'é', ...(dialect === 'postgres' ? ['🔑'] : [])]
  return fc
    .tuple(fc.constantFrom('a', 'Z', '_', 'é', 'パ'), fc.array(fc.constantFrom(...rest), { maxLength: 3 }))
    .map(([first, more]) => first + more.join(''))
}

/** `q`…`q` around generated text; where backslashes escape, a quote inside is written either way: doubled, or after a backslash. */
function quoted(q: string, backslash: boolean): fc.Arbitrary<string> {
  return fc
    .tuple(inner, fc.boolean())
    .map(
      ([s, backslashQuote]) =>
        `${q}${(backslash ? s.replace(/\\/g, '\\\\') : s).replaceAll(q, backslash && backslashQuote ? `\\${q}` : q + q)}${q}`
    )
}

/** A literal the server reads back whole, its content written as that server escapes it. */
function literal(dialect: Dialect): fc.Arbitrary<string> {
  const rules = lexicalRules(dialect)
  const forms = [quoted("'", rules.backslashEscapes), quoted('"', rules.backslashEscapes)]
  if (rules.backtickIdentifiers) forms.push(quoted('`', false))
  if (rules.escapeStrings) forms.push(quoted("'", true).map((s) => `E${s}`))
  if (rules.dollarQuotes) {
    const dollar = fc
      .record({ body: inner, tag: fc.constantFrom('', 't', 'a1', 'パ', 'tパ') })
      .filter(({ body, tag }) => `${body}$${tag}$`.indexOf(`$${tag}$`) === body.length)
      .map(({ body, tag }) => `$${tag}$${body}$${tag}$`)
    forms.push(dollar)
  }
  return fc.oneof(...forms)
}

/**
 * Code and a literal with nothing between them, where the server decides by what comes before the quote:
 * - a literal prefix that ends an identifier is part of the name, and the string after it is a plain one:
 *   PostgreSQL `abcE'…'` / `éE'…'` / `a$E'…'` (no backslash escapes, unlike `E'…'`), MySQL `abcN'…'`
 * - an `E` after anything that cannot continue a name starts an escape string (PostgreSQL): `(E'…'`, `'s'E'…'`,
 *   and `$$x$$E'…'` (that `$` closes a dollar quote; it is not part of a name)
 * - MySQL's own prefixes: `N'…'` and `_utf8mb4'…'` read backslashes like any string; `X'…'` / `B'…'` hold digits only
 * Digits are kept away from the prefix: `1E'…'` is an error on PostgreSQL 15 and later.
 */
function adjacent(dialect: Dialect): fc.Arbitrary<string> {
  const rules = lexicalRules(dialect)
  const plain = quoted("'", rules.backslashEscapes)
  if (rules.escapeStrings) {
    const named = fc
      .tuple(identifier(dialect), fc.constantFrom('E', 'e', 'N', 'X', 'B', 'U&'), plain)
      .map(([name, prefix, s]) => name + prefix + s)
    const escaping = fc
      .tuple(
        fc.constantFrom('(', ',', '+', '"q"', "'s'", '$$x$$', '$t$;$t$'),
        fc.constantFrom('E', 'e'),
        quoted("'", true)
      )
      .map(([before, prefix, s]) => before + prefix + s)
    return fc.oneof(named, escaping)
  }
  const named = fc
    .tuple(identifier(dialect), fc.constantFrom('N', 'X', 'B', 'E', '_utf8mb4'), plain)
    .map(([name, prefix, s]) => name + prefix + s)
  const introduced = fc.tuple(fc.constantFrom('N', 'n', '_utf8mb4', '_latin1'), plain).map(([p, s]) => p + s)
  return fc.oneof(named, introduced, fc.constantFrom("X'0aF'", "x''", "B'01'", "b'1'"))
}

/** What the server reads (`sql`), and what `stripComments` gives back for it (`stripped`). */
interface Piece {
  sql: string
  stripped: string
}
const kept = (sql: string): Piece => ({ sql, stripped: sql })

/** A comment: a block one (that cannot nest or turn into a MySQL version comment) or a line one with its newline. */
function comment(dialect: Dialect): fc.Arbitrary<Piece> {
  const rules = lexicalRules(dialect)
  const text = inner.filter((s) => !s.includes('*/') && !(rules.nestedBlockComments && s.includes('/*')))
  const lineText = inner.filter((s) => !/[\r\n]/.test(s))
  // Stripped, a block comment becomes a space; a line comment goes, and its newline stays.
  const block = text.map((s) => ({ sql: `/* ${s} */`, stripped: ' ' }))
  const line = lineText.map((s) => ({ sql: `-- ${s}\n`, stripped: '\n' }))
  if (rules.nestedBlockComments) {
    // PostgreSQL: the first `*/` closes only the inner comment.
    const nested = fc
      .tuple(text, text, text)
      .map(([a, b, c]) => ({ sql: `/* ${a} /* ${b} */ ${c}; */`, stripped: ' ' }))
    return fc.oneof(block, line, nested)
  }
  return rules.hashComments
    ? fc.oneof(
        block,
        line,
        lineText.map((s) => ({ sql: `# ${s}\n`, stripped: '\n' }))
      )
    : fc.oneof(block, line)
}

/** One statement: SELECT, then code, names, literals (some glued to code) and comments (a line one brings its newline). */
function statement(dialect: Dialect): fc.Arbitrary<Piece> {
  // MySQL: `--` is a comment only before whitespace.
  const code = fc.constantFrom(...CODE, ...(dialect === 'mysql' ? ['2--2', 'a--b'] : []))
  const token = fc.oneof(
    code.map(kept),
    identifier(dialect).map(kept),
    literal(dialect).map(kept),
    adjacent(dialect).map(kept),
    comment(dialect)
  )
  return fc.array(token, { maxLength: 6 }).map((tokens) => ({
    sql: ['SELECT', ...tokens.map((t) => t.sql)].join(' '),
    stripped: ['SELECT', ...tokens.map((t) => t.stripped)].join(' '),
  }))
}

const separator = fc.constantFrom(';', '; ', ';\n', ' ;\n\n', ';\r\n', ';\t')

/** A script of statements joined by separators, with where each one starts. */
function script(dialect: Dialect) {
  return fc.array(fc.tuple(statement(dialect), separator), { minLength: 1, maxLength: 5 }).map((parts) => {
    let text = ''
    let stripped = ''
    const starts: number[] = []
    for (const [piece, sep] of parts) {
      starts.push(text.length)
      text += piece.sql + sep
      stripped += piece.stripped + sep
    }
    return { text, stripped, statements: parts.map(([piece]) => piece.sql.trim()), starts }
  })
}

const linesBefore = (text: string, at: number) => text.slice(0, at).split('\n').length

describe('splitStatements (properties)', () => {
  for (const dialect of DIALECTS) {
    it(`gives back the statements a script was made of, with the line each starts on (${dialect})`, () => {
      fc.assert(
        fc.property(script(dialect), ({ text, statements, starts }) => {
          const state: { delimiter?: string; unterminated?: boolean } = {}
          const out = splitStatements(text, dialect, state)
          expect(out.map((s) => s.sql)).toEqual(statements)
          expect(out.map((s) => s.line)).toEqual(starts.map((at) => linesBefore(text, at)))
          expect(state).toEqual({ delimiter: ';', unterminated: false })
        }),
        params
      )
    })

    it(`does not split inside a literal or comment that never closes, and says so (${dialect})`, () => {
      const opener = fc.constantFrom("'", '"', '/*', ...(dialect === 'postgres' ? ['$$', "E'"] : ['`']))
      fc.assert(
        fc.property(script(dialect), opener, inner, ({ text, statements }, open, rest) => {
          const closer = open === '/*' ? '*/' : open === "E'" ? "'" : open
          fc.pre(!rest.includes(closer) && !(open === "E'" && rest.includes('\\')))
          const tail = `SELECT ${open}${rest}; SELECT 2;`
          const state: { unterminated?: boolean } = {}
          const out = splitStatements(text + tail, dialect, state)
          expect(out.map((s) => s.sql)).toEqual([...statements, tail.trim()])
          expect(state.unterminated).toBe(true)
        }),
        params
      )
    })

    it(`keeps literals as they are and drops comments without changing the statement count (${dialect})`, () => {
      fc.assert(
        fc.property(script(dialect), ({ text, statements, stripped: expected }) => {
          const stripped = stripComments(text, dialect)
          expect(stripped).toBe(expected)
          expect(splitStatements(stripped, dialect)).toHaveLength(statements.length)
          expect(stripComments(stripped, dialect)).toBe(stripped)
        }),
        params
      )
    })

    it(`never throws, and counts what it splits (${dialect})`, () => {
      const anyText = fc.oneof(
        fc.string({ unit: 'binary', maxLength: 60 }),
        fc
          .array(fc.oneof(INNER, fc.constantFrom(...CODE, 'COPY t FROM stdin;\n', '\\.\n', 'SET sql_mode=')), {
            maxLength: 20,
          })
          .map((parts) => parts.join(''))
      )
      fc.assert(
        fc.property(anyText, (text) => {
          const out = splitStatements(text, dialect, {})
          expect(countStatements(text, dialect)).toBe(out.length)
          // No blank statement (a COPY block keeps its data as it is, trailing whitespace included).
          for (const s of out) expect(s.sql.trim()).not.toBe('')
          expect(out.every((s, k) => k === 0 || s.line >= (out[k - 1] as { line: number }).line)).toBe(true)
        }),
        params
      )
    })
  }
})
