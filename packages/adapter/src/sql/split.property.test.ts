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

/** A literal the server reads back whole, its content written as that server escapes it. */
function literal(dialect: Dialect): fc.Arbitrary<string> {
  const rules = lexicalRules(dialect)
  // Where backslashes escape, a quote inside is written either way: doubled, or after a backslash.
  const quoted = (q: string, backslash: boolean) =>
    fc
      .tuple(inner, fc.boolean())
      .map(
        ([s, backslashQuote]) =>
          `${q}${(backslash ? s.replace(/\\/g, '\\\\') : s).replaceAll(q, backslash && backslashQuote ? `\\${q}` : q + q)}${q}`
      )
  const forms = [quoted("'", rules.backslashEscapes), quoted('"', rules.backslashEscapes)]
  if (rules.backtickIdentifiers) forms.push(quoted('`', false))
  if (rules.escapeStrings) forms.push(quoted("'", true).map((s) => `E${s}`))
  if (rules.dollarQuotes) {
    const dollar = fc
      .record({ body: inner, tag: fc.constantFrom('', 't', 'a1', 'パ') })
      .filter(({ body, tag }) => `${body}$${tag}$`.indexOf(`$${tag}$`) === body.length)
      .map(({ body, tag }) => `$${tag}$${body}$${tag}$`)
    forms.push(dollar)
  }
  return fc.oneof(...forms)
}

/** A comment: a block one (that cannot nest or turn into a MySQL version comment) or a line one with its newline. */
function comment(dialect: Dialect): fc.Arbitrary<string> {
  const rules = lexicalRules(dialect)
  const text = inner.filter((s) => !s.includes('*/') && !(rules.nestedBlockComments && s.includes('/*')))
  const block = text.map((s) => `/* ${s} */`)
  const line = inner.filter((s) => !/[\r\n]/.test(s)).map((s) => `-- ${s}\n`)
  if (rules.nestedBlockComments) {
    // PostgreSQL: the first `*/` closes only the inner comment.
    const nested = fc.tuple(text, text, text).map(([a, b, c]) => `/* ${a} /* ${b} */ ${c}; */`)
    return fc.oneof(block, line, nested)
  }
  return rules.hashComments
    ? fc.oneof(
        block,
        line,
        line.map((s) => `#${s.slice(2)}`)
      )
    : fc.oneof(block, line)
}

/** One statement: SELECT, then code, literals and comments (a line comment brings its newline). */
function statement(dialect: Dialect): fc.Arbitrary<string> {
  const token = fc.oneof(fc.constantFrom(...CODE), literal(dialect), comment(dialect))
  return fc.array(token, { maxLength: 6 }).map((tokens) => ['SELECT', ...tokens].join(' '))
}

const separator = fc.constantFrom(';', '; ', ';\n', ' ;\n\n', ';\r\n', ';\t')

/** A script of statements joined by separators, with where each one starts. */
function script(dialect: Dialect) {
  return fc.array(fc.tuple(statement(dialect), separator), { minLength: 1, maxLength: 5 }).map((parts) => {
    let text = ''
    const starts: number[] = []
    for (const [sql, sep] of parts) {
      starts.push(text.length)
      text += sql + sep
    }
    return { text, statements: parts.map(([sql]) => sql.trim()), starts }
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
        fc.property(script(dialect), ({ text, statements }) => {
          const stripped = stripComments(text, dialect)
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
