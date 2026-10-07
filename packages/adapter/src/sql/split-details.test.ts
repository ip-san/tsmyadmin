import { describe, expect, it } from 'vitest'
import { countStatements, setAssignments, splitStatements, stripComments, stripLeadingComments } from './split.ts'

/**
 * The details of how the splitter reads a script, one at a time: what ends a literal or a comment, what is code and
 * what is not, which client commands sit between statements. `split.test.ts` has the cases of a whole script; these
 * pin the edges a mutation run found no test noticed (a quote that ends one position early, a comment that stays open).
 */
const sqls = (input: string, dialect: 'mysql' | 'postgres') => splitStatements(input, dialect).map((s) => s.sql)
const stateOf = (input: string, dialect: 'mysql' | 'postgres') => {
  const state: { delimiter?: string; unterminated?: boolean } = {}
  splitStatements(input, dialect, state)
  return state
}

describe('stripLeadingComments', () => {
  it('skips whitespace and every comment above the code, and returns from the first code character', () => {
    expect(stripLeadingComments('  \n-- a\n /* b */\n# c\n  SELECT 1', 'mysql')).toBe('SELECT 1')
    expect(stripLeadingComments('-- a\n-- b\n/* c */ -- d\nSELECT 1', 'postgres')).toBe('SELECT 1')
  })

  it('leaves the statement alone when it starts with code or with a literal', () => {
    expect(stripLeadingComments('SELECT 1 -- c', 'mysql')).toBe('SELECT 1 -- c')
    expect(stripLeadingComments("'a' -- c", 'postgres')).toBe("'a' -- c")
  })

  it('keeps a MySQL version comment, which the server runs, and drops a plain one', () => {
    expect(stripLeadingComments('/*!40101 SET x = 1 */', 'mysql')).toBe('/*!40101 SET x = 1 */')
    expect(stripLeadingComments('/* x */ /*!40101 SET x = 1 */', 'mysql')).toBe('/*!40101 SET x = 1 */')
    expect(stripLeadingComments('/*!40101 SET x = 1 */', 'postgres')).toBe('')
  })

  it('is empty for nothing but comments and whitespace, a comment without its end, and an empty text', () => {
    expect(stripLeadingComments('-- only a comment', 'mysql')).toBe('')
    expect(stripLeadingComments('/* open SELECT 1', 'mysql')).toBe('')
    expect(stripLeadingComments('  \n ', 'mysql')).toBe('')
    expect(stripLeadingComments('', 'mysql')).toBe('')
  })

  it('ends a line comment at its line, so the code on the next line is what is left', () => {
    expect(stripLeadingComments('-- a\nSELECT 1', 'mysql')).toBe('SELECT 1')
    expect(stripLeadingComments('-- a\r\nSELECT 1', 'mysql')).toBe('SELECT 1')
  })
})

describe('stripComments', () => {
  it('drops a line comment but not its line break, and turns a block comment into one space', () => {
    expect(stripComments('a -- c\nb', 'mysql')).toBe('a \nb')
    expect(stripComments('a/* c */b', 'postgres')).toBe('a b')
  })

  it('copies a literal as it is, comment characters inside it included', () => {
    expect(stripComments('SELECT \'-- not a comment\', "/* nor this */"', 'postgres')).toBe(
      'SELECT \'-- not a comment\', "/* nor this */"'
    )
  })

  it('keeps the body of a MySQL version comment, in spaces, and reads one that is never closed as far as it goes', () => {
    expect(stripComments('a /*!50001 SELECT 1 */ b', 'mysql')).toBe('a  SELECT 1  b')
    expect(stripComments('/*! x */', 'mysql')).toBe(' x ')
    expect(stripComments('/*!40101 open', 'mysql')).toBe(' !40101 open ')
  })

  it('treats # as a comment on MySQL only', () => {
    expect(stripComments('a # c\nb', 'mysql')).toBe('a \nb')
    expect(stripComments('a # c\nb', 'postgres')).toBe('a # c\nb')
  })
})

describe('where a literal ends', () => {
  it('doubles a quote inside it, and ends at the single one', () => {
    expect(sqls("SELECT 'it''s; fine'; SELECT 2", 'postgres')).toEqual(["SELECT 'it''s; fine'", 'SELECT 2'])
    expect(sqls('SELECT "a""b;c"; SELECT 2', 'mysql')).toEqual(['SELECT "a""b;c"', 'SELECT 2'])
  })

  it('reads a MySQL backslash as an escape, and an escaped backslash before the closing quote as a backslash', () => {
    expect(sqls("SELECT 'a\\'; b'; SELECT 2", 'mysql')).toEqual(["SELECT 'a\\'; b'", 'SELECT 2'])
    expect(sqls("SELECT 'a\\\\'; SELECT 2", 'mysql')).toEqual(["SELECT 'a\\\\'", 'SELECT 2'])
  })

  it('reads a PostgreSQL backslash as itself, except in an E-string', () => {
    expect(sqls("SELECT 'a\\'; SELECT 2", 'postgres')).toEqual(["SELECT 'a\\'", 'SELECT 2'])
    expect(sqls("SELECT E'a\\'; b'; SELECT 2", 'postgres')).toEqual(["SELECT E'a\\'; b'", 'SELECT 2'])
    expect(sqls("SELECT e'a\\'; b'; SELECT 2", 'postgres')).toEqual(["SELECT e'a\\'; b'", 'SELECT 2'])
  })

  it('does not take an e at the end of a word for the start of an E-string', () => {
    expect(sqls("SELECT xe'a\\'; SELECT 2", 'postgres')).toEqual(["SELECT xe'a\\'", 'SELECT 2'])
    expect(sqls("SELECT $e'a\\'; SELECT 2", 'postgres')).toEqual(["SELECT $e'a\\'", 'SELECT 2'])
    // At the very start of the text there is nothing before the quote to look at.
    expect(sqls("'a\\'; SELECT 2", 'postgres')).toEqual(["'a\\'", 'SELECT 2'])
  })

  it('takes a quote of the other kind inside a literal as an ordinary character', () => {
    expect(sqls(`SELECT 'a"b;c'; SELECT "a'b;c"`, 'postgres')).toEqual([`SELECT 'a"b;c'`, `SELECT "a'b;c"`])
  })

  it('reports a literal that is never closed, and takes the rest of the text into it', () => {
    expect(sqls("SELECT 'open; SELECT 2", 'mysql')).toEqual(["SELECT 'open; SELECT 2"])
    expect(stateOf("SELECT 'open; SELECT 2", 'mysql').unterminated).toBe(true)
    expect(stateOf("SELECT 'closed'; SELECT 2", 'mysql').unterminated).toBe(false)
  })
})

describe('PostgreSQL dollar quotes', () => {
  it('ends at the same tag only, and keeps the semicolons inside', () => {
    expect(sqls('SELECT $a$ x; $b$ y; $a$; SELECT 2', 'postgres')).toEqual(['SELECT $a$ x; $b$ y; $a$', 'SELECT 2'])
    expect(sqls('SELECT $$ x; $$; SELECT 2', 'postgres')).toEqual(['SELECT $$ x; $$', 'SELECT 2'])
  })

  it('takes $1 and $name$ without a closing tag for what they are: a parameter, not a quote', () => {
    expect(sqls('SELECT $1; SELECT $2', 'postgres')).toEqual(['SELECT $1', 'SELECT $2'])
    expect(sqls('SELECT $1$ x; SELECT 2', 'postgres').length).toBeGreaterThan(1)
  })

  it('allows a tag of letters, digits after the first, underscores and non-ASCII letters', () => {
    expect(sqls('SELECT $tag_1$ ; $tag_1$; SELECT 2', 'postgres')).toHaveLength(2)
    expect(sqls('SELECT $タグ$ ; $タグ$; SELECT 2', 'postgres')).toHaveLength(2)
  })

  it('reports one that is never closed', () => {
    expect(stateOf('SELECT $a$ open; SELECT 2', 'postgres').unterminated).toBe(true)
    expect(sqls('SELECT $a$ open; SELECT 2', 'postgres')).toHaveLength(1)
  })
})

describe('where a comment ends', () => {
  it('ends a block comment at its own closing, nested ones on PostgreSQL only', () => {
    expect(sqls('/* a */ SELECT 1; SELECT 2', 'mysql')).toEqual(['/* a */ SELECT 1', 'SELECT 2'])
    // Nested: the second `/*` opens a comment inside the first, so one `*/` closes only the inner one and the rest of
    // the text is still comment (nothing to run). On MySQL the first `*/` ends it.
    expect(sqls('/* a /* b */ SELECT 1; SELECT 2', 'postgres')).toEqual([])
    expect(stateOf('/* a /* b */ SELECT 1; SELECT 2', 'postgres').unterminated).toBe(true)
    expect(sqls('/* a /* b */ SELECT 1; SELECT 2', 'mysql')).toEqual(['/* a /* b */ SELECT 1', 'SELECT 2'])
    expect(sqls('/* a /* b */ c */ SELECT 1; SELECT 2', 'postgres')).toEqual(['/* a /* b */ c */ SELECT 1', 'SELECT 2'])
  })

  it('reports a block comment that is never closed', () => {
    expect(stateOf('SELECT 1 /* open', 'mysql').unterminated).toBe(true)
    expect(stateOf('SELECT 1 /* closed */', 'mysql').unterminated).toBe(false)
  })

  it('ends a line comment at its line break, or at the end of the text', () => {
    expect(sqls('SELECT 1 -- c; still\n; SELECT 2', 'postgres')).toEqual(['SELECT 1 -- c; still', 'SELECT 2'])
    expect(sqls('SELECT 1; -- last', 'mysql')).toEqual(['SELECT 1'])
  })

  it('reads -- as a comment at the very end of the text on MySQL, where nothing follows it to need a space', () => {
    expect(sqls('SELECT 1;--', 'mysql')).toEqual(['SELECT 1'])
    expect(sqls('SELECT 1;--', 'postgres')).toEqual(['SELECT 1'])
    expect(sqls('SELECT 2--2', 'mysql')).toEqual(['SELECT 2--2'])
  })

  it('counts a version comment as code, and a plain comment as nothing', () => {
    expect(sqls('/*!40101 SET x = 1 */;', 'mysql')).toEqual(['/*!40101 SET x = 1 */'])
    expect(sqls('/* c */;', 'mysql')).toEqual([])
    expect(sqls('/*!40101 SET x = 1 */;', 'postgres')).toEqual([])
  })

  it('counts a literal as code even when nothing else is there', () => {
    expect(sqls("'x';", 'mysql')).toEqual(["'x'"])
    expect(sqls('"x";', 'postgres')).toEqual(['"x"'])
  })
})

describe('setAssignments', () => {
  it('reads each pair of a SET list with the name in lower case and the value trimmed', () => {
    expect(setAssignments("SET SESSION SQL_MODE = ' A ' , autocommit=0")).toEqual([
      { name: 'sql_mode', value: "' A '" },
      { name: 'autocommit', value: '0' },
    ])
    expect(setAssignments('set @Saved := @@sql_mode')).toEqual([{ name: '@saved', value: '@@sql_mode' }])
  })

  it('is empty for what is not a SET statement, a server-wide SET, and anything that only starts like SET', () => {
    for (const sql of [
      'SELECT 1',
      'SETTLE x = 1',
      'SET',
      "SET GLOBAL sql_mode = 'A'",
      "SET PERSIST sql_mode = 'A'",
      "SET PERSIST_ONLY sql_mode = 'A'",
    ])
      expect(setAssignments(sql), sql).toEqual([])
  })

  it('keeps only the session pair of a list that also sets a server-wide one', () => {
    expect(setAssignments("SET @@global.sql_mode = 'A', @@session.sql_mode = 'B'")).toEqual([
      { name: 'sql_mode', value: "'B'" },
    ])
    expect(setAssignments("SET @@persist.sql_mode = 'A', LOCAL autocommit = 1")).toEqual([
      { name: 'autocommit', value: '1' },
    ])
  })

  it('reads through the comments above the statement and a version-comment wrapper', () => {
    expect(setAssignments("-- c\n/*!40101 SET sql_mode = 'A' */")).toEqual([{ name: 'sql_mode', value: "'A'" }])
    expect(setAssignments("# c\nSET sql_mode = 'A'")).toEqual([{ name: 'sql_mode', value: "'A'" }])
  })

  it('takes a value with a comma inside quotes or parentheses whole', () => {
    expect(setAssignments("SET sql_mode = 'A,B', autocommit = (1)")).toEqual([
      { name: 'sql_mode', value: "'A,B'" },
      { name: 'autocommit', value: '(1)' },
    ])
  })
})

describe('what a SET does to how MySQL reads a backslash (NO_BACKSLASH_ESCAPES)', () => {
  /** Whether a backslash is a plain character after `prefix`: the script after it splits at `'a\'` only then. */
  const noBackslashAfter = (prefix: string) => {
    const before = splitStatements(`${prefix};`, 'mysql').length
    const after = splitStatements(`${prefix};\nSELECT 'a\\';\nSELECT 2`, 'mysql').length
    return after - before === 2
  }
  const ON = "SET sql_mode = 'NO_BACKSLASH_ESCAPES'"

  it('starts as off, and is turned on by a literal that holds the mode, in any case, among others', () => {
    expect(noBackslashAfter('SELECT 1')).toBe(false)
    expect(noBackslashAfter(ON)).toBe(true)
    expect(noBackslashAfter('SET sql_mode = "no_backslash_escapes"')).toBe(true)
    expect(noBackslashAfter("SET SESSION sql_mode = 'ANSI,NO_BACKSLASH_ESCAPES,TRADITIONAL'")).toBe(true)
    expect(noBackslashAfter("SET @@session.sql_mode = 'NO_BACKSLASH_ESCAPES'")).toBe(true)
  })

  it('is turned off by a literal without it, by DEFAULT, and by a mode name that is not it', () => {
    expect(noBackslashAfter(`${ON};\nSET sql_mode = ''`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = 'ANSI'`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = DEFAULT`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = default`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = ANSI`)).toBe(false)
  })

  it('is turned on by the mode name written without quotes', () => {
    expect(noBackslashAfter('SET sql_mode = NO_BACKSLASH_ESCAPES')).toBe(true)
    expect(noBackslashAfter('SET sql_mode = no_backslash_escapes')).toBe(true)
  })

  it('goes back to what a user variable saved, and to the usual mode for one that was never saved here', () => {
    expect(noBackslashAfter(`${ON};\nSET @saved = @@sql_mode;\nSET sql_mode = ''`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET @saved = @@sql_mode;\nSET sql_mode = ''; SET sql_mode = @saved`)).toBe(true)
    expect(noBackslashAfter(`${ON};\nSET @saved = @@session.sql_mode;\nSET sql_mode = ''; SET sql_mode = @Saved`)).toBe(
      true
    )
    expect(noBackslashAfter(`${ON};\nSET sql_mode = @never_saved`)).toBe(false)
  })

  it('does not take a variable that holds something else for the saved mode', () => {
    expect(noBackslashAfter(`${ON};\nSET @x = 1;\nSET sql_mode = ''; SET sql_mode = @x`)).toBe(false)
  })

  it('reads REPLACE of the mode as taking it out, and CONCAT as putting it in', () => {
    expect(noBackslashAfter(`${ON};\nSET sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = REPLACE(@@session.sql_mode, "NO_BACKSLASH_ESCAPES", '')`)).toBe(
      false
    )
    expect(noBackslashAfter("SET sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")).toBe(true)
    expect(noBackslashAfter("SET sql_mode = CONCAT_WS(',', @@sql_mode, 'NO_BACKSLASH_ESCAPES')")).toBe(true)
  })

  it('leaves it as it is for an expression it cannot read, and for a statement that is not about sql_mode', () => {
    expect(noBackslashAfter(`${ON};\nSET sql_mode = UPPER(@@sql_mode)`)).toBe(true)
    expect(noBackslashAfter('SET sql_mode = UPPER(@@sql_mode)')).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET autocommit = 0`)).toBe(true)
    expect(noBackslashAfter(`${ON};\nSELECT 1`)).toBe(true)
  })

  it('does not follow a server-wide SET, which changes no session', () => {
    expect(noBackslashAfter("SET GLOBAL sql_mode = 'NO_BACKSLASH_ESCAPES'")).toBe(false)
    expect(noBackslashAfter("SET @@global.sql_mode = 'NO_BACKSLASH_ESCAPES'")).toBe(false)
  })

  it('does not exist on PostgreSQL, where a SET of that name changes nothing about literals', () => {
    const script = `${ON};\nSELECT 'a\\';\nSELECT 2`
    expect(splitStatements(script, 'postgres')).toHaveLength(3)
  })
})

describe('what sits between statements', () => {
  it('takes a PostgreSQL psql meta-command as a statement of its own, with the line it is on', () => {
    expect(splitStatements('\\connect db\nSELECT 1;', 'postgres')).toEqual([
      { sql: '\\connect db', line: 1 },
      { sql: 'SELECT 1', line: 2 },
    ])
  })

  it('drops psql’s \\restrict and \\unrestrict, which only psql understands', () => {
    const script = '\\restrict abc123\nSELECT 1;\n\\unrestrict abc123\n'
    expect(sqls(script, 'postgres')).toEqual(['SELECT 1'])
  })

  it('takes a backslash inside a statement, or after other text on its line, for ordinary text', () => {
    expect(sqls('SELECT 1\n\\x\n;', 'postgres')).toEqual(['SELECT 1\n\\x'])
    expect(sqls('SELECT 1; SELECT 2', 'mysql')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(sqls('\\connect db', 'mysql')).toEqual(['\\connect db'])
  })

  it('takes a MySQL DELIMITER line, in any case, only at the start of a line and before any code of the statement', () => {
    expect(sqls('delimiter //\nSELECT 1; SELECT 2//\nDELIMITER ;\nSELECT 3;', 'mysql')).toEqual([
      'SELECT 1; SELECT 2',
      'SELECT 3',
    ])
    expect(sqls('SELECT 1 DELIMITER //\n;', 'mysql')).toEqual(['SELECT 1 DELIMITER //'])
    expect(sqls('SELECT 1\nDELIMITER //\n;', 'mysql')).toEqual(['SELECT 1\nDELIMITER //'])
    expect(sqls('DELIMITERS //\nSELECT 1;', 'mysql')).toEqual(['DELIMITERS //\nSELECT 1'])
  })

  it('reports the delimiter in force when the text ends, and the default one after DELIMITER ;', () => {
    expect(stateOf('DELIMITER //\nSELECT 1//', 'mysql').delimiter).toBe('//')
    expect(stateOf('DELIMITER //\nSELECT 1//\nDELIMITER ;\n', 'mysql').delimiter).toBe(';')
    expect(stateOf('SELECT 1;', 'mysql').delimiter).toBe(';')
  })
})

describe('COPY … FROM stdin', () => {
  it('keeps the data lines and the terminator line with the statement, and goes on after it', () => {
    const script = 'COPY t (a, b) FROM stdin;\n1\tx\n2\ty\n\\.\nSELECT 2;'
    expect(sqls(script, 'postgres')).toEqual(['COPY t (a, b) FROM stdin\n1\tx\n2\ty\n\\.', 'SELECT 2'])
  })

  it('reads an empty block, and a terminator with trailing blanks', () => {
    expect(sqls('COPY t FROM stdin;\n\\.\nSELECT 2;', 'postgres')).toEqual(['COPY t FROM stdin\n\\.', 'SELECT 2'])
    expect(sqls('COPY t FROM stdin;\n1\n\\. \t\nSELECT 2;', 'postgres')).toEqual([
      'COPY t FROM stdin\n1\n\\.',
      'SELECT 2',
    ])
  })

  it('reads a block with Windows line endings without a phantom first row, the rows keeping their own endings', () => {
    expect(sqls('COPY t FROM stdin;\r\n1\r\n\\.\r\nSELECT 2;', 'postgres')).toEqual([
      'COPY t FROM stdin\n1\r\n\\.',
      'SELECT 2',
    ])
  })

  it('reports a block that never ends, and keeps what there is', () => {
    const script = 'COPY t FROM stdin;\n1\n2'
    expect(stateOf(script, 'postgres').unterminated).toBe(true)
    expect(sqls(script, 'postgres')).toEqual(['COPY t FROM stdin\n1\n2'])
    expect(stateOf('COPY t FROM stdin;\n1\n\\.\n', 'postgres').unterminated).toBe(false)
  })

  it('does not take text that only looks like one for a COPY block, or a MySQL script for one', () => {
    expect(sqls('COPY t TO stdout;\nSELECT 2;', 'postgres')).toEqual(['COPY t TO stdout', 'SELECT 2'])
    expect(sqls('COPY t FROM stdin;\n1;\nSELECT 2;', 'mysql')).toEqual(['COPY t FROM stdin', '1', 'SELECT 2'])
  })
})

describe('PostgreSQL BEGIN ATOMIC', () => {
  const fn = (body: string) => `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC ${body} END;\nSELECT 99;`

  it('keeps a body of several statements together, up to its END', () => {
    expect(sqls(fn('SELECT 1; SELECT 2;'), 'postgres')).toEqual([
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END',
      'SELECT 99',
    ])
  })

  it('reads the keywords in any case, and a CASE … END inside the body as part of it', () => {
    expect(sqls(fn('SELECT CASE WHEN true THEN 1 ELSE 2 END; SELECT 3;').toLowerCase(), 'postgres')).toHaveLength(2)
    expect(sqls(fn('SELECT CASE WHEN true THEN 1 ELSE 2 END; SELECT 3;'), 'postgres')).toHaveLength(2)
    expect(sqls(fn('SELECT CASE WHEN a THEN CASE WHEN b THEN 1 END END; SELECT 3;'), 'postgres')).toHaveLength(2)
  })

  it('does not take a plain BEGIN, a CASE outside a body, or a word that holds one of the keywords, for a body', () => {
    expect(sqls('BEGIN; SELECT 1; COMMIT;', 'postgres')).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
    expect(sqls('SELECT CASE WHEN true THEN 1 END; SELECT 2;', 'postgres')).toHaveLength(2)
    expect(sqls('SELECT xBEGIN ATOMIC; SELECT 2;', 'postgres')).toHaveLength(2)
    expect(sqls('SELECT $BEGIN ATOMIC; SELECT 2;', 'postgres')).toHaveLength(2)
    expect(sqls('SELECT ENDING; SELECT 2;', 'postgres')).toHaveLength(2)
  })

  it('does not exist on MySQL, where a statement ends at the semicolon whatever it says', () => {
    expect(sqls(fn('SELECT 1; SELECT 2;'), 'mysql').length).toBeGreaterThan(2)
  })
})

describe('line numbers, and counting', () => {
  it('numbers the line of each statement’s first code, after the comments above it and the blank lines', () => {
    expect(splitStatements('-- c\n\n  SELECT 1;\n\n/* b */ SELECT 2;\nSELECT 3;', 'mysql').map((s) => s.line)).toEqual([
      3, 5, 6,
    ])
  })

  it('counts the statements without keeping them, the same as splitting', () => {
    const script = "SELECT 1;\nCOPY t FROM stdin;\n1\n\\.\n-- c\nSELECT 'x;y';"
    expect(countStatements(script, 'postgres')).toBe(splitStatements(script, 'postgres').length)
    expect(countStatements('', 'mysql')).toBe(0)
  })
})

describe('what is not a literal or a comment, though it looks like the start of one', () => {
  it('reads a backtick identifier on MySQL without a backslash escape, and a double-quoted name on PostgreSQL likewise', () => {
    expect(sqls('SELECT `a\\`; SELECT 2', 'mysql')).toEqual(['SELECT `a\\`', 'SELECT 2'])
    expect(sqls('SELECT e"a\\"; SELECT 2', 'postgres')).toEqual(['SELECT e"a\\"', 'SELECT 2'])
  })

  it('does not open a comment at a / or a * on its own, or at a - on its own', () => {
    expect(sqls('SELECT 2 ** 3; SELECT 4', 'mysql')).toEqual(['SELECT 2 ** 3', 'SELECT 4'])
    expect(sqls('SELECT 2 ** 3; SELECT 4', 'postgres')).toEqual(['SELECT 2 ** 3', 'SELECT 4'])
    expect(sqls('SELECT 6 / 3; SELECT 4', 'postgres')).toEqual(['SELECT 6 / 3', 'SELECT 4'])
    expect(sqls('SELECT 5 - 3; SELECT 4', 'mysql')).toEqual(['SELECT 5 - 3', 'SELECT 4'])
    expect(sqls('SELECT 5 - 3; SELECT 4', 'postgres')).toEqual(['SELECT 5 - 3', 'SELECT 4'])
  })

  it('does not nest a comment at a / that is not followed by a *', () => {
    expect(sqls('/* a / b */ SELECT 1; SELECT 2', 'postgres')).toEqual(['/* a / b */ SELECT 1', 'SELECT 2'])
  })
})

describe('text that is only a literal that is never closed', () => {
  it('is a statement (a literal is code), and is reported as not closed', () => {
    for (const [text, dialect] of [
      ["'open", 'mysql'],
      ['"open', 'postgres'],
      ['$a$ open', 'postgres'],
    ] as const) {
      expect(sqls(text, dialect), text).toEqual([text])
      expect(stateOf(text, dialect).unterminated, text).toBe(true)
    }
    expect(stripLeadingComments("'open", 'mysql')).toBe("'open")
  })

  it('is reported as closed once it is, whichever kind it is', () => {
    expect(stateOf('SELECT $$ x $$', 'postgres').unterminated).toBe(false)
    expect(stateOf('SELECT "x"', 'postgres').unterminated).toBe(false)
    expect(stateOf('SELECT 1 -- a comment', 'mysql').unterminated).toBe(false)
    expect(stateOf('SELECT 1 # a comment', 'mysql').unterminated).toBe(false)
  })
})

describe('stripComments: the body of a MySQL version comment', () => {
  it('takes the number after /*! and the blanks around the body away, and keeps the body’s own line breaks', () => {
    expect(stripComments('/*!50001SELECT 1*/', 'mysql')).toBe(' SELECT 1 ')
    expect(stripComments('/*!   x   */', 'mysql')).toBe(' x ')
    expect(stripComments('/*!40101 a\nb */', 'mysql')).toBe(' a\nb ')
    expect(stripComments('/*!*/', 'mysql')).toBe('  ')
  })
})

describe('setAssignments: which SET statements it reads', () => {
  it('is empty for a server-wide SET however it is spaced or cased, and reads one with only a line break after SET', () => {
    for (const sql of [
      "SET   GLOBAL sql_mode = 'A'",
      "set\tpersist sql_mode = 'A'",
      "SET\nPERSIST_ONLY sql_mode = 'A'",
    ])
      expect(setAssignments(sql), sql).toEqual([])
    expect(setAssignments("SET\nsql_mode = 'A'")).toEqual([{ name: 'sql_mode', value: "'A'" }])
    expect(setAssignments("set sql_mode = 'A'")).toEqual([{ name: 'sql_mode', value: "'A'" }])
  })

  it('does not take a statement that has SET only further in for one', () => {
    expect(setAssignments("UPDATE t SET sql_mode = 'A'")).toEqual([])
    expect(setAssignments("SELECT 'SET sql_mode = 1'")).toEqual([])
  })
})

describe('NO_BACKSLASH_ESCAPES: values that only look like the ones it reads', () => {
  const noBackslashAfter = (prefix: string) => {
    const before = splitStatements(`${prefix};`, 'mysql').length
    const after = splitStatements(`${prefix};\nSELECT 'a\\';\nSELECT 2`, 'mysql').length
    return after - before === 2
  }
  const ON = "SET sql_mode = 'NO_BACKSLASH_ESCAPES'"

  it('reads only sql_mode as the mode: another variable set to a mode name changes nothing', () => {
    expect(noBackslashAfter(`${ON};\nSET autocommit = ON`)).toBe(true)
    expect(noBackslashAfter('SET autocommit = NO_BACKSLASH_ESCAPES')).toBe(false)
  })

  it('reads a bare mode name only when it is exactly that one', () => {
    expect(noBackslashAfter('SET sql_mode = NO_BACKSLASH_ESCAPES_X')).toBe(false)
    expect(noBackslashAfter('SET sql_mode = XNO_BACKSLASH_ESCAPES')).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = XDEFAULT`)).toBe(false)
  })

  it('takes a server-side variable (@@…) for no saved mode, and leaves the flag as it is', () => {
    expect(noBackslashAfter(`${ON};\nSET sql_mode = @@global.sql_mode`)).toBe(true)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = @@session.sql_mode`)).toBe(true)
  })

  it('reads REPLACE and CONCAT only when they are the whole value, however they are spaced', () => {
    expect(noBackslashAfter(`${ON};\nSET sql_mode = REPLACE ( @@sql_mode , 'NO_BACKSLASH_ESCAPES' , '' )`)).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = UPPER(REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', ''))`)).toBe(true)
    expect(noBackslashAfter("SET sql_mode = CONCAT (@@sql_mode, ',NO_BACKSLASH_ESCAPES')")).toBe(true)
    expect(noBackslashAfter("SET sql_mode = UPPER(CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES'))")).toBe(false)
    expect(noBackslashAfter(`${ON};\nSET sql_mode = REPLACE(@@sql_mode, 'ANSI', '')`)).toBe(true)
  })
})

describe('the edges of the client commands and of SET', () => {
  it('reads a SET only at the start of the statement, and keeps a server-wide one out even when its list goes on', () => {
    expect(setAssignments("XYZ sql_mode = 'A'")).toEqual([])
    expect(setAssignments("A SET ,sql_mode = 'A'")).toEqual([])
    // MySQL sets the later variables of `SET GLOBAL a = 1, b = 2` at the session level; this reader leaves a statement
    // that starts server-wide out altogether (a documented simplification), however it is spaced.
    expect(setAssignments("SET GLOBAL x = 1, sql_mode = 'NO_BACKSLASH_ESCAPES'")).toEqual([])
    expect(setAssignments("SET  GLOBAL x = 1, sql_mode = 'A'")).toEqual([])
    expect(setAssignments("SET PERSIST x = 1, sql_mode = 'A'")).toEqual([])
  })

  it('takes the end of a COPY block at the end of the text as its end', () => {
    const script = 'COPY t FROM stdin;\n1\n\\.'
    expect(sqls(script, 'postgres')).toEqual(['COPY t FROM stdin\n1\n\\.'])
    expect(stateOf(script, 'postgres').unterminated).toBe(false)
  })

  it('takes a psql meta-command at the end of the text, without its trailing blanks or carriage return', () => {
    expect(splitStatements('\\connect db', 'postgres')).toEqual([{ sql: '\\connect db', line: 1 }])
    expect(splitStatements('\\connect db  \t\r\nSELECT 1;', 'postgres')).toEqual([
      { sql: '\\connect db', line: 1 },
      { sql: 'SELECT 1', line: 2 },
    ])
  })

  it('drops \\restrict only when the command is that word, not one that holds it', () => {
    expect(sqls('\\echo \\restrict\nSELECT 1;', 'postgres')).toEqual(['\\echo \\restrict', 'SELECT 1'])
    expect(sqls('\\restrict\nSELECT 1;', 'postgres')).toEqual(['SELECT 1'])
    expect(sqls('\\restricted x\nSELECT 1;', 'postgres')).toEqual(['\\restricted x', 'SELECT 1'])
  })

  it('takes a backslash or a DELIMITER that follows a comment on its own line for ordinary text', () => {
    expect(sqls('/**/\\connect x\nSELECT 1;', 'postgres')).toEqual(['/**/\\connect x\nSELECT 1'])
    expect(sqls('/**/DELIMITER //\nSELECT 1;', 'mysql')).toEqual(['/**/DELIMITER //\nSELECT 1'])
    expect(sqls('/* c */\nDELIMITER //\nSELECT 1//', 'mysql')).toEqual(['SELECT 1'])
  })

  it('needs the whole of BEGIN ATOMIC, spaced however, to open a body', () => {
    const body = (opening: string) => `CREATE FUNCTION f() RETURNS int ${opening} SELECT 1; END; SELECT 2;`
    expect(sqls(body('BEGIN   ATOMIC'), 'postgres')).toHaveLength(2)
    expect(sqls(body('BEGIN\n  ATOMIC'), 'postgres')).toHaveLength(2)
    expect(sqls('BEGIN x ATOMIC; SELECT 2;', 'postgres')).toEqual(['BEGIN x ATOMIC', 'SELECT 2'])
    expect(sqls('BEGIN ATOMICALLY; SELECT 2;', 'postgres')).toEqual(['BEGIN ATOMICALLY', 'SELECT 2'])
  })

  it('does not let a CASE outside a body count against the END that closes one later', () => {
    const script =
      'SELECT CASE WHEN true THEN 1 END; CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END; SELECT 2;'
    expect(sqls(script, 'postgres')).toEqual([
      'SELECT CASE WHEN true THEN 1 END',
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END',
      'SELECT 2',
    ])
  })
})
