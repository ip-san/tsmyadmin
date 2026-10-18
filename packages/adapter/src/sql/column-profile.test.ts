import { PROFILE_MAX_COLUMNS, PROFILE_SAMPLE_ROWS } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { rows, scripted } from '../test/scripted-conn.ts'
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
        { column: 'id', nulls: 0, distinct: 4 },
        { column: 'data', nulls: 1, distinct: null },
      ],
      omitted: 0,
    })
    const [q] = s.asked
    // The sample is a derived table with a bound limit; a column whose values are not compared is not DISTINCTed.
    expect(q?.text).toMatch(/FROM \(SELECT `id` AS `c0`, `data` AS `c1` FROM `shop`\.`orders` LIMIT \?\) AS `sample`/)
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
    expect(p.columns).toEqual([{ column: 'a', nulls: 1, distinct: 2 }])
    const none = await columnProfileOn(scripted([[/COUNT/, rows([[0]])]]).conn, 'postgres', ns, 't', [])
    expect(none).toEqual({ sampled: 0, capped: false, columns: [], omitted: 0 })
  })
})

describe('comparable', () => {
  it('compares plain values, and not binary, JSON, spatial or array values', () => {
    for (const t of ['int', 'varchar(20)', 'text', 'timestamp with time zone', 'numeric(10,2)', 'uuid', 'boolean'])
      expect(comparable(t), t).toBe(true)
    for (const t of [
      'blob',
      'longblob',
      'bytea',
      'varbinary(16)',
      'json',
      'jsonb',
      'xml',
      'geometry',
      'point',
      'integer[]',
      'tsvector',
      'bit(8)',
    ])
      expect(comparable(t), t).toBe(false)
  })
})
