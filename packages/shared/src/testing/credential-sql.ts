import fc from 'fast-check'
import type { Dialect } from '../schemas/dialect.ts'

/**
 * Generators for property tests of password masking (the audit log, the debug panel): SQL that holds a password in
 * every credential position the masking code knows, written the way the server reads it, with password content made
 * of the characters that broke the masking before (quotes, doubled and escaped quotes, backslashes, `$` tags,
 * comment openers, newlines, non-ASCII). Every fragment of a generated password carries `SECRET_MARK`, so "the mark
 * is not in the output" means no part of the password survived, however the literal was cut.
 */

/** In no template, noise statement or mask here; letters only, so it cannot be read as a quote or a tag. */
export const SECRET_MARK = 'Zq7'

/** Pieces the password is built from: each one has broken a masking rule somewhere, or reads as code / a literal. */
const RISKY = [
  "'",
  "''",
  '"',
  '""',
  '\\',
  "\\'",
  '\\"',
  '\\\\',
  '$',
  '$$',
  '$t$',
  '$a1$',
  '$パ$',
  ';',
  '\n',
  '\r\n',
  '\t',
  ' ',
  '-- ',
  '--',
  '#',
  '/*',
  '*/',
  '/*!',
  '`',
  'IDENTIFIED BY ',
  'PASSWORD ',
  'password=',
  "E'",
  '=',
  '(',
  ')',
  '@',
  '%',
  'パス',
  'é',
  '🔑',
]

/** Password content: a mark between every two pieces (and at both ends), so each fragment of it has one. */
export const passwordBody: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...RISKY) },
      { weight: 1, arbitrary: fc.string({ maxLength: 3 }) },
      { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 2 }) }
    ),
    { maxLength: 8 }
  )
  .map((pieces) => `${SECRET_MARK}${pieces.map((p) => `${p}${SECRET_MARK}`).join('')}`)

/** A string literal the server reads back as `body`, or an unterminated opening of one (nothing may follow it). */
export interface PasswordLiteral {
  text: string
  /** Never closed: the server reads the rest of the input as part of it, so it has to end the script. */
  open: boolean
}

const singleQuoted = (dialect: Dialect, body: string, prefix: string, backslashQuote: boolean, close: boolean) => {
  // MySQL reads a backslash as an escape; PostgreSQL's standard strings read it as itself.
  const escaped =
    dialect === 'mysql' || prefix === 'E'
      ? body.replace(/\\/g, '\\\\').replace(/'/g, backslashQuote ? "\\'" : "''")
      : body.replace(/'/g, "''")
  return `${prefix}'${escaped}${close ? "'" : ''}`
}

const DOLLAR_TAGS = ['', 't', 'a1', 'パ', '_x']

/** `body` as a literal of `dialect`, in one of the forms that dialect accepts. */
export function passwordLiteral(dialect: Dialect, body: string): fc.Arbitrary<PasswordLiteral> {
  const prefixes = dialect === 'mysql' ? ['', 'N', '_utf8mb4', '_binary'] : ['', 'E', 'U&', 'N']
  const quoted = fc
    .record({ prefix: fc.constantFrom(...prefixes), backslashQuote: fc.boolean(), open: fc.boolean() })
    .map(({ prefix, backslashQuote, open }) => ({
      text: singleQuoted(dialect, body, prefix, backslashQuote, !open),
      open,
    }))
  if (dialect === 'mysql') {
    // MySQL (without ANSI_QUOTES) reads "…" as a string as well.
    const doubleQuoted = fc.boolean().map((open) => {
      const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '""')
      return { text: `"${escaped}${open ? '' : '"'}`, open }
    })
    return fc.oneof(quoted, doubleQuoted)
  }
  // A dollar quote ends at the first repeat of its tag, so the body may not hold it (nor end in a part of it).
  const tags = DOLLAR_TAGS.filter((tag) => `${body}$${tag}$`.indexOf(`$${tag}$`) === body.length)
  if (tags.length === 0) return quoted
  const dollar = fc
    .record({ tag: fc.constantFrom(...tags), open: fc.boolean() })
    .map(({ tag, open }) => ({ text: `$${tag}$${body}${open ? '' : `$${tag}$`}`, open }))
  return fc.oneof(quoted, dollar)
}

/** A statement with `{}` where the password literal goes, and what may follow a closed literal. */
interface CredentialTemplate {
  sql: string
  tails: string[]
}

/** Every credential position the masking code handles (see `sql-secrets.ts` and the audit log's patterns). */
const TEMPLATES: Record<Dialect, CredentialTemplate[]> = {
  mysql: [
    { sql: "CREATE USER 'app'@'%' IDENTIFIED BY {}", tails: ['', ' WITH MAX_QUERIES_PER_HOUR 5', " COMMENT 'x'"] },
    { sql: 'CREATE USER IF NOT EXISTS app IDENTIFIED WITH caching_sha2_password BY {}', tails: ['', ' ACCOUNT LOCK'] },
    { sql: "ALTER USER 'app'@'localhost' IDENTIFIED WITH mysql_native_password AS {}", tails: [''] },
    { sql: 'ALTER USER app IDENTIFIED BY {}', tails: ['', " REPLACE 'old'", ' RETAIN CURRENT PASSWORD'] },
    { sql: "ALTER USER app IDENTIFIED BY 'new' REPLACE {}", tails: ['', ' RETAIN CURRENT PASSWORD'] },
    { sql: "GRANT SELECT ON *.* TO 'app'@'%' IDENTIFIED BY {}", tails: ['', ' WITH GRANT OPTION'] },
    { sql: 'SET PASSWORD = {}', tails: [''] },
    { sql: "SET PASSWORD FOR 'app'@'%' = {}", tails: [''] },
    { sql: 'SET PASSWORD FOR app = PASSWORD({})', tails: [''] },
    { sql: 'CREATE USER app IDENTIFIED VIA ed25519 USING PASSWORD({})', tails: [''] },
    { sql: 'CREATE USER app IDENTIFIED VIA mysql_native_password USING {}', tails: [''] },
    { sql: "CREATE SERVER s FOREIGN DATA WRAPPER mysql OPTIONS (USER 'u', PASSWORD {})", tails: [''] },
    {
      sql: "CHANGE REPLICATION SOURCE TO SOURCE_HOST = 'h', SOURCE_PASSWORD = {}",
      tails: ['', ', SOURCE_PORT = 3306'],
    },
    { sql: 'CHANGE MASTER TO MASTER_PASSWORD={}', tails: [''] },
    { sql: "START REPLICA USER = 'u' PASSWORD = {}", tails: [''] },
  ],
  postgres: [
    { sql: 'CREATE USER app PASSWORD {}', tails: ['', " VALID UNTIL '2030-01-01'"] },
    { sql: 'CREATE ROLE app WITH LOGIN ENCRYPTED PASSWORD {}', tails: ['', ' CREATEDB'] },
    { sql: 'ALTER ROLE "App" WITH PASSWORD {}', tails: ['', " VALID UNTIL 'infinity'"] },
    { sql: 'ALTER USER app PASSWORD {}', tails: [''] },
    { sql: "CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password {})", tails: [''] },
    { sql: 'ALTER USER MAPPING FOR app SERVER s OPTIONS (SET password {})', tails: [''] },
    { sql: "CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'h', password {})", tails: [''] },
  ],
}

/** A credential statement: the password, where it sits, and whether its literal was left open. */
export interface CredentialStatement {
  sql: string
  body: string
  open: boolean
}

/** A credential statement of `dialect` with a generated password in one of its positions. */
export function credentialStatement(dialect: Dialect): fc.Arbitrary<CredentialStatement> {
  return fc
    .record({ template: fc.constantFrom(...TEMPLATES[dialect]), body: passwordBody, gap: fc.constantFrom(...GAPS) })
    .chain(({ template, body, gap }) =>
      fc
        .record({ literal: passwordLiteral(dialect, body), tail: fc.constantFrom(...template.tails) })
        .map(({ literal, tail }) => {
          const [head, rest] = template.sql.split('{}') as [string, string]
          const sql = `${head}${gap}${literal.text}${literal.open ? '' : `${rest}${tail}`}`
          return { sql, body, open: literal.open }
        })
    )
}

/** What may stand between the keyword and the literal: nothing, whitespace, or a comment holding a quote. */
const GAPS = ['', ' ', '\n', " /* it's */ ", ' -- "quoted"\n', ' /* $$ */ ']

/** A password inside a connection string or URL (CREATE SUBSCRIPTION, dblink, FEDERATED tables). */
export function connectionStatement(dialect: Dialect): fc.Arbitrary<CredentialStatement> {
  // A bare value in a connection string or URL ends at whitespace, a quote, `@` or `;`. A URL's password may hold an
  // unencoded `/`, and a connection string's a backslash-escaped space (libpq reads `a\ b` as `a b`).
  const chars = (extra: string[]) =>
    fc
      .array(fc.constantFrom('a', 'Z', '9', '.', '_', '~', '!', '-', '+', 'é', ...extra), { maxLength: 6 })
      .map((cs) => `${SECRET_MARK}${cs.join('')}${SECRET_MARK}`)
  const bare = chars(['/'])
  const escaped = chars(['\\ ', '\\\\'])
  if (dialect === 'mysql') {
    return bare.map((pw) => ({
      sql: `CREATE TABLE ft (id INT) ENGINE=FEDERATED CONNECTION='mysql://u:${pw}@h:3306/db/t'`,
      body: pw,
      open: false,
    }))
  }
  return fc
    .record({
      pw: bare,
      form: fc.constantFrom(
        {
          conn: true,
          sql: (pw: string) => `CREATE SUBSCRIPTION s CONNECTION 'host=h password=${pw} dbname=d' PUBLICATION p`,
        },
        { conn: true, sql: (pw: string) => `SELECT dblink_connect('c', 'host=h port=5432 password = ${pw}')` },
        {
          conn: false,
          sql: (pw: string) => `CREATE SUBSCRIPTION s CONNECTION 'postgresql://u:${pw}@h/db' PUBLICATION p`,
        },
        { conn: false, sql: (pw: string) => `SELECT dblink_connect('postgres://u:${pw}@h:5432/db')` }
      ),
      escaped,
    })
    .map(({ pw, form, escaped: esc }) => {
      const body = form.conn ? esc : pw
      return { sql: form.sql(body), body, open: false }
    })
}

/** Statements the server reads as they are, with quotes, comments and `;` inside literals, to put around a credential. */
export const NOISE: Record<Dialect, string[]> = {
  mysql: [
    'SELECT 1',
    "SELECT 'a;b'",
    'SELECT "x;\'"',
    "SELECT 'it''s'",
    "SELECT 'a\\'b;'",
    "-- it's\nSELECT 2",
    '/* ; " */ SELECT 3',
    "# hash's\nSELECT 4",
    'SELECT `we;ird`',
  ],
  postgres: [
    'SELECT 1',
    "SELECT 'a;b'",
    'SELECT "x;\'"',
    "SELECT 'it''s'",
    "SELECT 'a\\'",
    "SELECT E'a\\';b'",
    "SELECT $$;'$$",
    "-- it's\nSELECT 2",
    '/* /* ; */ " */ SELECT 3',
  ],
}

/** A script: noise statements, the credential statement, and more noise after it when its literal is closed. */
export function credentialScript(dialect: Dialect, statement = credentialStatement(dialect)) {
  const noise = fc.array(fc.constantFrom(...NOISE[dialect]), { maxLength: 3 })
  return fc.record({ before: noise, statement, after: noise }).map(({ before, statement, after }) => ({
    ...statement,
    sql: [...before, statement.sql, ...(statement.open ? [] : after)].join(';\n'),
  }))
}
