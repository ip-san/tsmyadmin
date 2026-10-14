import { describe, expect, it } from 'vitest'
import { inferType, type RowCell } from './infer-type.ts'

/**
 * The type a column made from a file is given: the narrowest one every value fits. A wrong answer here is a load that
 * fails halfway or a column that holds less than the file did.
 */

const column = (values: RowCell[], dialect: 'mysql' | 'postgres' = 'mysql') =>
  inferType(
    values.map((v) => [v]),
    0,
    dialect
  )
const dataType = (values: RowCell[], dialect: 'mysql' | 'postgres' = 'mysql') => column(values, dialect).dataType

describe('inferType: nothing to go on', () => {
  it('gives a column with no values a VARCHAR(255)', () => {
    expect(column([])).toEqual({ type: 'varchar', dataType: 'VARCHAR(255)' })
    expect(column([null, null])).toEqual({ type: 'varchar', dataType: 'VARCHAR(255)' })
    expect(inferType([[], []], 0, 'mysql').dataType).toBe('VARCHAR(255)')
    expect(inferType([['1'], ['2']], 5, 'mysql').dataType).toBe('VARCHAR(255)')
  })

  it('skips NULLs and rows that are too short, and judges by the values that are there', () => {
    expect(column([null, '1', null, '2'])).toEqual({ type: 'int', dataType: 'INT' })
    expect(inferType([['a'], [], ['1']], 1, 'mysql').dataType).toBe('VARCHAR(255)')
    expect(inferType([['x', '5'], ['y']], 1, 'mysql').dataType).toBe('INT')
  })
})

describe('inferType: integers', () => {
  it('takes whole numbers that fit 32 bits for INT, at the very edges', () => {
    expect(column(['0', '-1', '2147483647', '-2147483648'])).toEqual({ type: 'int', dataType: 'INT' })
    expect(column(['-0']).type).toBe('int')
  })

  it('moves to BIGINT one past either edge of INT, and to text one past either edge of BIGINT', () => {
    expect(column(['2147483648'])).toEqual({ type: 'bigint', dataType: 'BIGINT' })
    expect(column(['-2147483649'])).toEqual({ type: 'bigint', dataType: 'BIGINT' })
    expect(column(['1', '3000000000']).type).toBe('bigint')
    expect(column(['9223372036854775807', '-9223372036854775808']).type).toBe('bigint')
    expect(column(['9223372036854775808']).type).toBe('varchar')
    expect(column(['-9223372036854775809']).type).toBe('varchar')
  })

  it('takes a number written another way for text, so it comes back as it was written', () => {
    for (const odd of ['007', '+1', '1e3', ' 1', '1 ', '0x10', '1,000', '-', '--1', '']) {
      expect(column(['1', odd]).type, odd).not.toBe('int')
      expect(column([odd]).type, odd).toBe('varchar')
    }
  })
})

describe('inferType: decimals', () => {
  it('sizes a decimal by its longest whole part plus its longest fraction, and its scale', () => {
    expect(column(['1.5', '2.25'])).toEqual({ type: 'decimal', dataType: 'DECIMAL(3,2)' })
    expect(column(['10', '1.5'])).toEqual({ type: 'decimal', dataType: 'DECIMAL(3,1)' })
    expect(column(['-12.34'])).toEqual({ type: 'decimal', dataType: 'DECIMAL(4,2)' })
    expect(column(['0.5', '123.4'])).toEqual({ type: 'decimal', dataType: 'DECIMAL(4,1)' })
    expect(column(['1.5', null, '99999.123'])).toEqual({ type: 'decimal', dataType: 'DECIMAL(8,3)' })
  })

  it('keeps to the largest precision and scale, and falls to text beyond them', () => {
    const digits = (n: number) => '1'.repeat(n)
    expect(column([`${digits(8)}.${digits(30)}`]).dataType).toBe('DECIMAL(38,30)')
    expect(column([`${digits(7)}.${digits(31)}`]).type).toBe('varchar')
    expect(column([`${digits(9)}.${digits(30)}`]).type).toBe('varchar')
    expect(column([`${digits(37)}.1`]).dataType).toBe('DECIMAL(38,1)')
    expect(column([`${digits(38)}.1`]).type).toBe('varchar')
  })

  it('takes a number with no digit on either side of the point for text', () => {
    for (const odd of ['.5', '1.', '1.5.2', '1,5', '1.5e3', '+1.5'])
      expect(column(['1.5', odd]).type, odd).toBe('varchar')
  })
})

describe('inferType: dates', () => {
  it('takes real calendar dates, the edges of the range included', () => {
    expect(column(['2024-02-29', '1000-01-01', '9999-12-31', '2024-12-31'])).toEqual({ type: 'date', dataType: 'DATE' })
    expect(column(['2024-04-30', '2024-01-31']).type).toBe('date')
  })

  it('takes a date that is not on the calendar, or outside the years the servers keep, for text', () => {
    for (const bad of [
      '2023-02-29',
      '2024-04-31',
      '2024-13-01',
      '2024-00-10',
      '2024-01-00',
      '0999-12-31',
      '2024-1-1',
      '24-01-01',
      '2024/01/01',
    ]) {
      expect(column(['2024-01-01', bad]).type, bad).toBe('varchar')
    }
  })
})

describe('inferType: date-times', () => {
  it('writes the type the server takes: DATETIME on MySQL, TIMESTAMP on PostgreSQL', () => {
    expect(column(['2024-01-01 10:00:00', '2024-12-31T23:59:59'], 'mysql')).toEqual({
      type: 'datetime',
      dataType: 'DATETIME',
    })
    expect(column(['2024-01-01 10:00:00'], 'postgres')).toEqual({ type: 'datetime', dataType: 'TIMESTAMP' })
  })

  it('keeps the longest fraction of seconds on MySQL, which would otherwise round it away', () => {
    expect(dataType(['2024-01-01 10:00:00.5', '2024-01-01 10:00:00.123'])).toBe('DATETIME(3)')
    expect(dataType(['2024-01-01 10:00:00.123456'])).toBe('DATETIME(6)')
    expect(dataType(['2024-01-01 10:00:00', '2024-01-01 10:00:00.1'])).toBe('DATETIME(1)')
    expect(dataType(['2024-01-01 10:00:00.123'], 'postgres')).toBe('TIMESTAMP')
    expect(column(['2024-01-01 10:00:00.1234567']).type).toBe('varchar')
  })

  it('takes a time that does not exist, or a date that is not one, for text', () => {
    expect(column(['2024-01-01 23:59:59', '2024-01-01 00:00:00']).type).toBe('datetime')
    for (const bad of [
      '2024-01-01 24:00:00',
      '2024-01-01 10:60:00',
      '2024-01-01 10:00:60',
      '2023-02-29 10:00:00',
      '2024-01-01  10:00:00',
      '2024-01-01 1:00:00',
    ]) {
      expect(column(['2024-01-01 10:00:00', bad]).type, bad).toBe('varchar')
    }
  })

  it('takes a column that mixes dates and date-times for text', () => {
    expect(column(['2024-01-01', '2024-01-01 10:00:00']).type).toBe('varchar')
  })
})

describe('inferType: text and bytes', () => {
  it('counts characters, not units: 255 stay a VARCHAR(255), 256 become TEXT', () => {
    expect(column(['a'.repeat(255)])).toEqual({ type: 'varchar', dataType: 'VARCHAR(255)' })
    expect(column(['a'.repeat(256)])).toEqual({ type: 'text', dataType: 'TEXT' })
    const emoji = '\u{1F600}'
    expect(column([emoji.repeat(255)]).type).toBe('varchar')
    expect(column([emoji.repeat(256)]).type).toBe('text')
  })

  it('sizes MySQL TEXT by bytes, a character taking up to four, and PostgreSQL always TEXT', () => {
    expect(dataType(['a'.repeat(65_535)])).toBe('TEXT')
    expect(dataType(['a'.repeat(65_536)])).toBe('MEDIUMTEXT')
    // One 16 MB string, sliced for the byte below the limit: building it is the slow part of this file.
    const past = 'a'.repeat(16_777_216)
    expect(dataType([past.slice(1)])).toBe('MEDIUMTEXT')
    expect(dataType([past])).toBe('LONGTEXT')
    expect(dataType(['\u{1F600}'.repeat(16_383)])).toBe('TEXT')
    expect(dataType(['\u{1F600}'.repeat(16_384)])).toBe('MEDIUMTEXT')
    expect(dataType([past], 'postgres')).toBe('TEXT')
    expect(dataType(['a'.repeat(300)], 'postgres')).toBe('TEXT')
  })

  it('judges the longest value of the column', () => {
    expect(dataType(['a', 'a'.repeat(300), 'b'])).toBe('TEXT')
  })

  it('makes a column that holds bytes text, whatever else it holds, sized by its encoded length', () => {
    expect(column([{ base64: 'AAAA' }])).toEqual({ type: 'varchar', dataType: 'VARCHAR(255)' })
    expect(column([{ base64: 'A'.repeat(300) }]).type).toBe('text')
    expect(column(['1', { base64: 'AAAA' }, '2']).type).toBe('varchar')
    expect(column(['2024-01-01', { base64: 'AAAA' }]).type).toBe('varchar')
    expect(column([{ base64: 'A'.repeat(70_000) }]).dataType).toBe('MEDIUMTEXT')
  })
})
