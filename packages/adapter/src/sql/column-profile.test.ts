import { PROFILE_MAX_COLUMNS, PROFILE_SAMPLE_ROWS } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import { columnProfileOn, comparable } from './column-profile.ts'

const ns = { database: 'shop' }
const col = (name: string, dataType = 'int') => ({ name, dataType })

describe('columnProfileOn', () => {
  it('reads a sample of the first rows once, and counts each column in one statement', async () => {
    const s = scripted([[/COUNT/, rows([[4, 4, 4, 3, null]])]])
    const p = await columnProfileOn(s.conn, 'mysql', ns, 'orders', [col('id'), col('data', 'blob')])
    expect(p).toEqual({
      sampled: 4,
      capped: false,
      columns: [
        { column: 'id', nulls: 0, distinct: 4, prefix: false },
        { column: 'data', nulls: 1, distinct: null, prefix: false },
      ],
      omitted: 0,
    })
    const [q] = s.asked
    // The sample is a derived table with a bound limit. A column whose values are not compared is taken as only
    // whether it is NULL (a BLOB is not copied into the sample), and not DISTINCTed.
    expect(q?.text).toMatch(
      /FROM \(SELECT `id` AS `c0`, CASE WHEN `data` IS NULL THEN NULL ELSE 1 END AS `c1` FROM `shop`\.`orders` LIMIT \?\) AS `sample`/
    )
    expect(q?.text).not.toMatch(/DISTINCT `c1`/)
    expect(q?.params).toEqual([PROFILE_SAMPLE_ROWS])
  })

  it('says a full sample is capped, and counts the columns past the most it reads', async () => {
    const many = Array.from({ length: PROFILE_MAX_COLUMNS + 3 }, (_, i) => col(`c${i}`))
    const answer = [PROFILE_SAMPLE_ROWS, ...Array.from({ length: PROFILE_MAX_COLUMNS * 2 }, () => PROFILE_SAMPLE_ROWS)]
    const p = await columnProfileOn(scripted([[/COUNT/, rows([answer])]]).conn, 'postgres', ns, 'wide', many)
    expect(p.capped).toBe(true)
    expect(p.columns).toHaveLength(PROFILE_MAX_COLUMNS)
    expect(p.omitted).toBe(3)
  })

  it('reads counts that come back as strings (PostgreSQL bigint), and a table with no columns', async () => {
    const p = await columnProfileOn(scripted([[/COUNT/, rows([['3', '2', '2']])]]).conn, 'postgres', ns, 't', [
      col('a'),
    ])
    expect(p.columns).toEqual([{ column: 'a', nulls: 1, distinct: 2, prefix: false }])
    const none = await columnProfileOn(scripted([[/COUNT/, rows([[0]])]]).conn, 'postgres', ns, 't', [])
    expect(none).toEqual({ sampled: 0, capped: false, columns: [], omitted: 0 })
  })
})

describe('columnProfileOn, more', () => {
  it('compares long text by its first characters', async () => {
    const s = scripted([[/COUNT/, rows([[1, 1, 1]])]])
    await columnProfileOn(s.conn, 'postgres', ns, 't', [col('body', 'text')])
    expect(s.asked[0]?.text).toMatch(/LEFT\("body", 256\) AS "c0"/)
  })

  it.each([
    ['a refusal', fail('PERMISSION_DENIED')],
    ['a timeout (PostgreSQL)', fail('QUERY_FAILED', '57014')],
    ['a timeout (MySQL)', fail('QUERY_FAILED', 'ER_QUERY_TIMEOUT')],
    ['a lost connection', fail('CONNECTION_FAILED')],
  ])('does not count again after %s: it would fail again, and take as long', async (_, error) => {
    const s = scripted([[/COUNT/, error]])
    await expect(columnProfileOn(s.conn, 'postgres', ns, 't', [col('a')])).rejects.toBe(error)
    expect(s.asked).toHaveLength(1)
  })

  it('writes the whole statement: the counts of each column, then the sample they are taken from', async () => {
    const s = scripted([[/COUNT/, rows([[1, 1, 1, 1, null]])]])
    await columnProfileOn(s.conn, 'postgres', ns, 't', [col('a', 'int'), col('b', 'jsonb')])
    expect(s.asked[0]?.text).toBe(
      'SELECT COUNT(*), COUNT("c0"), COUNT(DISTINCT "c0"), COUNT("c1"), NULL FROM (SELECT "a" AS "c0", CASE WHEN "b" IS NULL THEN NULL ELSE 1 END AS "c1" FROM "public"."t" LIMIT $1) AS "sample"'
    )
    const none = scripted([[/COUNT/, rows([[0]])]])
    await columnProfileOn(none.conn, 'postgres', ns, 't', [])
    expect(none.asked[0]?.text).toBe('SELECT COUNT(*) FROM (SELECT 1 AS one FROM "public"."t" LIMIT $1) AS "sample"')
  })

  it('reads a type written with spaces around it, as a catalog may', () => {
    expect(comparable(' int ')).toBe(true)
  })

  it('marks long text as compared by its first characters', async () => {
    const s = scripted([[/COUNT/, rows([[2, 2, 1, 2, 2]])]])
    const p = await columnProfileOn(s.conn, 'mysql', ns, 't', [col('body', 'longtext'), col('name', 'varchar(9)')])
    expect(p.columns.map((c) => [c.column, c.prefix])).toEqual([
      ['body', true],
      ['name', false],
    ])
  })

  it('counts the NULLs again without distinct values when counting them fails', async () => {
    const s = scripted([
      [/DISTINCT/, fail('QUERY_FAILED')],
      [/COUNT/, rows([[3, 2, null]])],
    ])
    const p = await columnProfileOn(s.conn, 'postgres', ns, 't', [col('a', 'varchar(10)')])
    expect(p.columns).toEqual([{ column: 'a', nulls: 1, distinct: null, prefix: false }])
    expect(s.asked).toHaveLength(2)
  })
})

describe('comparable', () => {
  const plain = [
    'int',
    'tinyint(1)',
    'bigint unsigned',
    'varchar(20)',
    'character varying(10)',
    'text',
    'longtext',
    'timestamp with time zone',
    'double precision',
    'numeric(10,2)',
    'uuid',
    'boolean',
    "enum('a','b')",
    "set('x','y')",
    'year',
  ]
  // Binary, documents, spatial, arrays, bits, and the types a PostgreSQL schema names (a domain, a composite, an
  // enum): not known to be plain, so not counted.
  const other = [
    'blob',
    'longblob',
    'bytea',
    'varbinary(16)',
    'binary(4)',
    'json',
    'jsonb',
    'xml',
    'geometry',
    'geomcollection',
    'multipolygon',
    'point',
    'integer[]',
    'tsvector',
    'bit(8)',
    'bit varying(4)',
    'mydoc',
    'address',
    'mood',
  ]

  it.each(plain)('compares %s', (t) => expect(comparable(t)).toBe(true))
  it.each(other)('does not compare %s', (t) => expect(comparable(t)).toBe(false))
})
