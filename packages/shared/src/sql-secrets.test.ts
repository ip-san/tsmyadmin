import { describe, expect, it } from 'vitest'
import { PASSWORD_MASK } from './schemas/users.ts'
import { maskConnectionPassword, maskCredentialPart, sqlLiteralPattern } from './sql-secrets.ts'

/** The one masking rule the audit log and the debug panel share: what a password statement looks like afterwards. */

const M = `'${PASSWORD_MASK}'`

describe('maskCredentialPart', () => {
  it('masks the literal after IDENTIFIED BY / PASSWORD and keeps the account name and what follows the literal', () => {
    expect(maskCredentialPart("CREATE USER 'a'@'%' IDENTIFIED BY 'hunter2' WITH GRANT OPTION")).toBe(
      `CREATE USER 'a'@'%' IDENTIFIED BY ${M} WITH GRANT OPTION`
    )
    expect(maskCredentialPart("ALTER ROLE u PASSWORD 'x' VALID UNTIL 'infinity'")).toBe(`ALTER ROLE u PASSWORD ${M}`)
    expect(maskCredentialPart('ALTER USER u IDENTIFIED BY "x"')).toBe(`ALTER USER u IDENTIFIED BY ${M}`)
  })

  it('masks nested quoting as one span, so it leaves no fragment', () => {
    // `'''` closes the inner literal and the outer one at once: read from inside, it never closes.
    expect(maskCredentialPart("EXECUTE format('ALTER ROLE u PASSWORD ''hunter2''')")).toBe(
      `EXECUTE format('ALTER ROLE u PASSWORD ${M}`
    )
    expect(maskCredentialPart("SET @s = 'CREATE USER x IDENTIFIED BY ''p'''; PREPARE st FROM @s")).toBe(
      `SET @s = 'CREATE USER x IDENTIFIED BY ${M}`
    )
    expect(maskCredentialPart("EXECUTE format('ALTER ROLE u PASSWORD ''hunter2'' LOGIN')")).toBe(
      `EXECUTE format('ALTER ROLE u PASSWORD ${M}`
    )
  })

  it('masks to the end when a later literal never closes, or a comment opens among the literals', () => {
    // Found by the property tests: the span used to end at the last quote, the opening of the unclosed literal.
    expect(maskCredentialPart("ALTER USER u IDENTIFIED BY 'new' REPLACE 'old-secret")).toBe(
      `ALTER USER u IDENTIFIED BY ${M}`
    )
    // The comment's quote paired with the password's opening one, and the password was read as code after it.
    expect(maskCredentialPart("CREATE USER u PASSWORD /* it's */ 'secret")).toBe(`CREATE USER u PASSWORD ${M}`)
    expect(maskCredentialPart("CREATE USER u PASSWORD -- it's\n'secret' LOGIN")).toBe(`CREATE USER u PASSWORD ${M}`)
    // PostgreSQL reads `'a\'` as a whole string (`a\`): `'a\''secret` is a string, then an unclosed one.
    expect(maskCredentialPart("ALTER USER u PASSWORD 'a\\''secret")).toBe(`ALTER USER u PASSWORD ${M}`)
  })

  it('masks to the end when the literal never closes: an escaped, doubled or missing last quote, or a $ tag not repeated', () => {
    for (const tail of [
      "'abc\\'def",
      // MySQL's escaped quote is PostgreSQL's closing one: where such a literal ends depends on the server.
      "'abc\\'def' WITH x",
      "'abc''def",
      "'abc",
      '"abc\\"def',
      '"abc""def',
      "'abc\\'def' more 'x'",
      '$$abc',
      '$$abc more words',
      '$tag$abc $other$ more',
    ]) {
      expect(maskCredentialPart(`ALTER USER u IDENTIFIED BY ${tail}`), tail).toBe(`ALTER USER u IDENTIFIED BY ${M}`)
    }
  })

  it('keeps the tail after a literal that does close, doubled quotes and escaped backslashes inside it included', () => {
    for (const lit of ["'abc\\\\'", "'abc''def'", "''", '"a""b"', '$$abc$$', '$tag$abc$tag$']) {
      expect(maskCredentialPart(`ALTER USER u IDENTIFIED BY ${lit} WITH x`), lit).toBe(
        `ALTER USER u IDENTIFIED BY ${M} WITH x`
      )
    }
    // The prefix of a PostgreSQL escape string is not part of the secret: the mask starts at the quote.
    expect(maskCredentialPart("ALTER USER u IDENTIFIED BY E'a\\nb' WITH x")).toBe(
      `ALTER USER u IDENTIFIED BY E${M} WITH x`
    )
  })

  it('masks a bare quote after the keyword, and leaves a statement without a credential keyword or without a literal alone', () => {
    expect(maskCredentialPart("x IDENTIFIED'")).toBe(`x IDENTIFIED${M}`)
    expect(maskCredentialPart('SELECT 1')).toBe('SELECT 1')
    // A keyword inside a literal is taken for one all the same: the rule hides more rather than less.
    expect(maskCredentialPart("SELECT 'IDENTIFIED' FROM t")).toBe(`SELECT 'IDENTIFIED${M}`)
    expect(maskCredentialPart('ALTER USER u IDENTIFIED BY 0x1234')).toBe('ALTER USER u IDENTIFIED BY 0x1234')
  })

  it('finds the keyword whatever its case, and a prefixed one such as REPLICATION_PASSWORD', () => {
    expect(maskCredentialPart("alter user u identified by 'x'")).toBe(`alter user u identified by ${M}`)
    expect(maskCredentialPart("CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = 'x', SOURCE_HOST = 'h'")).toBe(
      `CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = ${M}`
    )
    expect(maskCredentialPart("SELECT unidentified FROM t WHERE a = 'x'")).toBe(
      `SELECT unidentified FROM t WHERE a = 'x'`
    )
  })
})

describe('maskConnectionPassword', () => {
  it('masks password=… inside a connection string, up to a space, quote or semicolon, and nothing else', () => {
    expect(
      maskConnectionPassword("CREATE SUBSCRIPTION s CONNECTION 'host=h password=s3cret dbname=d' PUBLICATION p")
    ).toBe(`CREATE SUBSCRIPTION s CONNECTION 'host=h password=${PASSWORD_MASK} dbname=d' PUBLICATION p`)
    expect(maskConnectionPassword("dblink('password=abc;user=u')")).toBe(`dblink('password=${PASSWORD_MASK};user=u')`)
    expect(maskConnectionPassword('SELECT password FROM t')).toBe('SELECT password FROM t')
  })
})

describe('sqlLiteralPattern', () => {
  const whole = new RegExp(`^${sqlLiteralPattern(1, true)}$`)
  const loose = new RegExp(sqlLiteralPattern(1))

  it('matches a complete literal of each kind, and not one whose last quote is doubled or follows a backslash', () => {
    for (const s of [
      "'a'",
      "'a''b'",
      "'a\\\\'",
      "'a\\nb'",
      '"a"',
      "E'a'",
      "N'a'",
      "_utf8'a'",
      "U&'a'",
      "X'ff'",
      '$$a$$',
      '$t$a$t$',
      "''",
    ])
      expect(whole.test(s), s).toBe(true)
    // A backslash before a quote: MySQL's escape, PostgreSQL's backslash and end of the string.
    for (const s of ["'a''", "'a", '$$a', '$t$a$u$', 'a', "'a\\'b'", '"a\\"b"']) expect(whole.test(s), s).toBe(false)
  })

  it('without `whole`, stops at the first closing quote, as the coarse sweeps need', () => {
    expect(loose.exec("'a''b")?.[0]).toBe("'a'")
    expect(whole.test("'a''b")).toBe(false)
  })
})
