import { describe, expect, it } from 'vitest'
import { formatSql } from './sql-format.ts'

const compact = (s: string) => s.replace(/\s+/g, '')

describe('formatSql', () => {
  it('puts each clause on a line and the select list and conditions one to a line', () => {
    const sql =
      "select a, b, count(*) as n from users u left join posts p on p.user_id = u.id where u.id > 1 and u.name like 'x y' or u.id = 9 group by a, b order by n desc limit 5"
    expect(formatSql(sql)).toBe(
      [
        'select a,',
        '  b,',
        '  count(*) as n',
        'from users u',
        'left join posts p on p.user_id = u.id',
        'where u.id > 1',
        "  and u.name like 'x y'",
        '  or u.id = 9',
        'group by a,',
        '  b',
        'order by n desc',
        'limit 5',
      ].join('\n')
    )
  })

  it('keeps a BETWEEN ... AND together, a subquery on its line and FOR UPDATE / ON DELETE where they are', () => {
    expect(
      formatSql('select * from t where x between 1 and 2 and y in (select id from u where z = 1) for update')
    ).toBe(
      ['select *', 'from t', 'where x between 1 and 2', '  and y in (select id from u where z = 1) for update'].join(
        '\n'
      )
    )
    expect(formatSql('create table t (a int, b int references u (id) on delete cascade)')).toBe(
      'create table t (a int, b int references u (id) on delete cascade)'
    )
  })

  it('lays out UPDATE, INSERT with VALUES rows, DELETE and several statements', () => {
    expect(formatSql('update t set a = 1, b = 2 where id = 3; delete from t where id = 4;')).toBe(
      ['update t', 'set a = 1,', '  b = 2', 'where id = 3;', '', 'delete from t', 'where id = 4;'].join('\n')
    )
    expect(formatSql('insert into t (a, b) values (1, 2), (3, 4) union select 5, 6')).toBe(
      ['insert into t (a, b)', 'values (1, 2),', '  (3, 4)', 'union', 'select 5,', '  6'].join('\n')
    )
  })

  it('leaves strings, identifiers and comments as written, and ends a line comment with a line', () => {
    const sql = "select 'a  ''b'' where', `from` from t -- where x\nwhere 1 /* and 2 */"
    const out = formatSql(sql)
    expect(out).toContain("'a  ''b'' where'")
    expect(out).toContain('`from`')
    expect(out).toContain('-- where x')
    expect(out).toContain('/* and 2 */')
    expect(out.split('\n').some((l) => l.endsWith('-- where x'))).toBe(true)
  })

  it('changes nothing but whitespace, and is stable when run again', () => {
    const samples = [
      'SELECT u.id, COUNT(p.id) FROM users u JOIN posts p ON p.uid = u.id WHERE u.a IS NOT NULL GROUP BY u.id HAVING COUNT(p.id) > 2 ORDER BY 2 DESC',
      "INSERT INTO `a b` (x) VALUES ('1;2'); SELECT $$x;y$$, :name, @v, a::int FROM t",
      'select left(a, 3), right(b, 2) from t natural left outer join u',
    ]
    for (const sql of samples) {
      const once = formatSql(sql)
      expect(compact(once)).toBe(compact(sql))
      expect(formatSql(once)).toBe(once)
    }
  })
})
