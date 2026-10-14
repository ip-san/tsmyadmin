import { describe, expect, it } from 'vitest'
import { formatSql, tokenizeSql } from './sql-format.ts'

/**
 * The layout rules of the SQL formatter and the tokens it reads. Only whitespace may change: a wrong rule here moves
 * a statement's text, so each rule has an exact case (found by mutation testing; see `bun run mutation`).
 */

const kinds = (sql: string) => tokenizeSql(sql).map((t) => `${t.kind}:${t.text}`)
const squash = (s: string) => s.replace(/\s+/g, '')

describe('tokenizeSql', () => {
  it('reads words, numbers, punctuation and quoted runs, each with where it starts', () => {
    const tokens = tokenizeSql('select a, 1.5e+3 from `t`')
    expect(tokens.map((t) => [t.kind, t.text, t.start])).toEqual([
      ['word', 'select', 0],
      ['word', 'a', 7],
      ['punct', ',', 8],
      ['word', '1.5e+3', 10],
      ['word', 'from', 17],
      ['quoted', '`t`', 22],
    ])
  })

  it('notes whether whitespace came before a token, and whether a blank line did', () => {
    const [a, b, c, d] = tokenizeSql('a b\nc\n\n d')
    expect([a?.gap, a?.blank]).toEqual([false, false])
    expect([b?.gap, b?.blank]).toEqual([true, false])
    expect([c?.gap, c?.blank]).toEqual([true, false])
    expect([d?.gap, d?.blank]).toEqual([true, true])
    expect(tokenizeSql('a\n \n b')[1]?.blank).toBe(true)
    expect(tokenizeSql('a  \n  b')[1]?.blank).toBe(false)
    expect(tokenizeSql('a,b').map((t) => t.gap)).toEqual([false, false, false])
  })

  it('keeps a quoted run whole: a doubled quote, a backslash escape in strings, none in backticks', () => {
    expect(kinds("'a''b' x")).toEqual(["quoted:'a''b'", 'word:x'])
    expect(kinds("'a\\'b' x")).toEqual(["quoted:'a\\'b'", 'word:x'])
    expect(kinds('"a""b" x')).toEqual(['quoted:"a""b"', 'word:x'])
    expect(kinds('`a\\` x')).toEqual(['quoted:`a\\`', 'word:x'])
    expect(kinds('`a``b` x')).toEqual(['quoted:`a``b`', 'word:x'])
    expect(kinds("'never closed")).toEqual(["quoted:'never closed"])
    expect(kinds("'a\\")).toEqual(["quoted:'a\\"])
    expect(kinds("''")).toEqual(["quoted:''"])
  })

  it('reads comments of the three kinds, a block comment that never closes running to the end', () => {
    expect(kinds('a -- note\nb')).toEqual(['word:a', 'comment:-- note', 'word:b'])
    expect(kinds('a # note\nb')).toEqual(['word:a', 'comment:# note', 'word:b'])
    expect(kinds('a /* x\n y */ b')).toEqual(['word:a', 'comment:/* x\n y */', 'word:b'])
    expect(kinds('a /* never closed')).toEqual(['word:a', 'comment:/* never closed'])
    expect(kinds('a / b')).toEqual(['word:a', 'punct:/', 'word:b'])
  })

  it('reads a dollar-quoted run, with or without a tag, and words with $, underscores and letters of any script', () => {
    expect(kinds('$$ x; y $$ z')).toEqual(['quoted:$$ x; y $$', 'word:z'])
    expect(kinds('$tag$ x $tag$ z')).toEqual(['quoted:$tag$ x $tag$', 'word:z'])
    expect(kinds('$a$ x $b$ z')).toEqual(['punct:$', 'word:a$', 'word:x', 'punct:$', 'word:b$', 'word:z'])
    expect(kinds('my_col$1 日本語')).toEqual(['word:my_col$1', 'word:日本語'])
    expect(kinds('_x')).toEqual(['word:_x'])
    expect(kinds('1.2.3 4')).toEqual(['word:1.2.3', 'word:4'])
    expect(kinds('a;b')).toEqual(['word:a', 'punct:;', 'word:b'])
  })
})

describe('formatSql: a clause to a line', () => {
  it('puts each clause on a line and the select list and conditions one to a line', () => {
    expect(
      formatSql(
        'select a,b from t where x=1 and y=2 or z=3 group by a, b having count(*)>1 order by a, b limit 5 offset 2'
      )
    ).toBe(
      [
        'select a,',
        '  b',
        'from t',
        'where x=1',
        '  and y=2',
        '  or z=3',
        'group by a,',
        '  b',
        'having count(*)>1',
        'order by a,',
        '  b',
        'limit 5',
        'offset 2',
      ].join('\n')
    )
  })

  it('starts a line at each join, and at a plain JOIN, but not at the JOIN of INNER JOIN', () => {
    expect(
      formatSql(
        'select * from a inner join b on a.x=b.x left outer join c on c.x=a.x and c.y=1 join d using (x) cross join e'
      )
    ).toBe(
      [
        'select *',
        'from a',
        'inner join b on a.x=b.x',
        'left outer join c on c.x=a.x',
        '  and c.y=1',
        'join d using (x)',
        'cross join e',
      ].join('\n')
    )
    expect(formatSql('select * from a natural join b straight_join c')).toBe(
      ['select *', 'from a', 'natural join b', 'straight_join c'].join('\n')
    )
    expect(formatSql('select * from a right join b full join c')).toBe(
      ['select *', 'from a', 'right join b', 'full join c'].join('\n')
    )
  })

  it('treats a join word followed by a parenthesis as a function, and left() of a column as no join', () => {
    expect(formatSql('select left(a, 2), right(b, 1) from t')).toBe(
      ['select left(a, 2),', '  right(b, 1)', 'from t'].join('\n')
    )
  })

  it('lays out unions and their selects', () => {
    expect(formatSql('select a from t union select b from u intersect select c from v except select d from w')).toBe(
      [
        'select a',
        'from t',
        'union',
        'select b',
        'from u',
        'intersect',
        'select c',
        'from v',
        'except',
        'select d',
        'from w',
      ].join('\n')
    )
  })

  it('keeps a BETWEEN … AND together and breaks the AND after it', () => {
    expect(formatSql('select 1 from t where a between 1 and 5 and b = 2')).toBe(
      ['select 1', 'from t', 'where a between 1 and 5', '  and b = 2'].join('\n')
    )
    expect(formatSql('select 1 from t where a between 1 and 5 and b between 2 and 3')).toBe(
      ['select 1', 'from t', 'where a between 1 and 5', '  and b between 2 and 3'].join('\n')
    )
  })

  it('breaks AND and OR only in a WHERE, ON or HAVING, never in a select list', () => {
    expect(formatSql('select a and b, c or d from t')).toBe(['select a and b,', '  c or d', 'from t'].join('\n'))
    expect(formatSql('select 1 from a join b on x and y')).toBe(
      ['select 1', 'from a', 'join b on x', '  and y'].join('\n')
    )
    expect(formatSql('select 1 from t having a or b')).toBe(['select 1', 'from t', 'having a', '  or b'].join('\n'))
  })
})

describe('formatSql: statements', () => {
  it('lays out UPDATE with SET items one to a line, DELETE, and RETURNING', () => {
    expect(formatSql('update t set a=1, b=2 where id=3 returning a')).toBe(
      ['update t', 'set a=1,', '  b=2', 'where id=3', 'returning a'].join('\n')
    )
    expect(formatSql('delete from t where a=1')).toBe(['delete from t', 'where a=1'].join('\n'))
    // The FROM of a DELETE stays on the statement's line; a join under it starts its own.
    expect(formatSql('delete t from t join u on t.a=u.a')).toBe(['delete t from t', 'join u on t.a=u.a'].join('\n'))
  })

  it('lays out INSERT with the rows of VALUES one to a line, and REPLACE the same way', () => {
    expect(formatSql('insert into t (a,b) values (1,2),(3,4)')).toBe(
      ['insert into t (a,b)', 'values (1,2),', '  (3,4)'].join('\n')
    )
    expect(formatSql('replace into t (a) values (1),(2)')).toBe(
      ['replace into t (a)', 'values (1),', '  (2)'].join('\n')
    )
    expect(formatSql('insert into t select a from u')).toBe(['insert into t', 'select a', 'from u'].join('\n'))
  })

  it('takes values( as a function when it is not the row list of an INSERT or REPLACE', () => {
    // ON DUPLICATE KEY UPDATE is no clause of its own, and the values( inside it is a call.
    expect(formatSql('insert into t (a) values (1) on duplicate key update a = values(a)')).toBe(
      ['insert into t (a)', 'values (1) on duplicate key update a = values(a)'].join('\n')
    )
    expect(formatSql('select values(a) from t')).toBe(['select values(a)', 'from t'].join('\n'))
  })

  it('starts a line at INSERT, UPDATE, DELETE, REPLACE and WITH only when they start a statement', () => {
    expect(formatSql('select 1 for update')).toBe('select 1 for update')
    expect(formatSql('create table t (a int, b int references u on delete cascade on update cascade)')).toBe(
      'create table t (a int, b int references u on delete cascade on update cascade)'
    )
    expect(formatSql('with c as (select 1) select * from c')).toBe(
      ['with c as (select 1)', 'select *', 'from c'].join('\n')
    )
  })

  it('ends a statement with a line, a blank line between statements, and the last one without trailing blanks', () => {
    expect(formatSql('select 1; select 2;')).toBe(['select 1;', '', 'select 2;'].join('\n'))
    expect(formatSql('select 1;\nselect 2')).toBe(['select 1;', '', 'select 2'].join('\n'))
    expect(formatSql('  select 1  ')).toBe('select 1')
    expect(formatSql('')).toBe('')
  })

  it('keeps a subquery in parentheses on its line, and what is inside a call in one piece', () => {
    expect(
      formatSql('select a, (select max(b) from u where u.a=t.a) from t where x in (select y from z where p and q)')
    ).toBe(
      [
        'select a,',
        '  (select max(b) from u where u.a=t.a)',
        'from t',
        'where x in (select y from z where p and q)',
      ].join('\n')
    )
    expect(formatSql('select f(a, b), g(c) from t')).toBe(['select f(a, b),', '  g(c)', 'from t'].join('\n'))
  })
})

describe('formatSql: blank lines, comments and spacing', () => {
  it('a blank line becomes a line break', () => {
    expect(formatSql('select a\n\nb')).toBe('select a\nb')
  })

  it('ends a line comment with a line, indented under a select list, and keeps a block comment where it is', () => {
    // The comma breaks the line first, so a comment after it opens the next item's line.
    expect(formatSql('select a, -- first\n b from t')).toBe(['select a,', '  -- first', '  b', 'from t'].join('\n'))
    expect(formatSql('select a -- tail\nfrom t')).toBe(['select a -- tail', 'from t'].join('\n'))
    // A clause after a line comment starts at the left edge, not under the select list the comment ended.
    expect(formatSql('select a -- tail\nfrom t where x=1 -- t2\nand y=2')).toBe(
      ['select a -- tail', 'from t', 'where x=1 -- t2', '  and y=2'].join('\n')
    )
    expect(formatSql('select a, b -- tail\norder by a')).toBe(['select a,', '  b -- tail', 'order by a'].join('\n'))
    expect(formatSql('select /* c */ a from t')).toBe(['select /* c */ a', 'from t'].join('\n'))
    expect(formatSql('# note\nselect 1')).toBe(['# note', 'select 1'].join('\n'))
  })

  it('joins tokens with one space where the source had space, and none where it had none', () => {
    expect(formatSql('select   a  ,b   from   t')).toBe(['select a ,', '  b', 'from t'].join('\n'))
    expect(formatSql('select a=1,b=2 from t')).toBe(['select a=1,', '  b=2', 'from t'].join('\n'))
  })

  it('changes nothing but whitespace, whatever it is given', () => {
    const samples = [
      // The doubled backtick is one identifier, so the BETWEEN and the comment after it are read as such.
      'select \'a;b\', "c--d", `e``f` from t where x between 1 and 2 -- c\n and y',
      'insert into t values (1),(2); update t set a=$$x;y$$ where b=1',
      'select 1 /* a */ union select 2 # b\n order by 1',
      "with r as (select 1) select * from r where a = 'it''s'",
    ]
    for (const sql of samples) {
      const out = formatSql(sql)
      expect(squash(out), sql).toBe(squash(sql))
      expect(formatSql(out), sql).toBe(out)
    }
  })
})
