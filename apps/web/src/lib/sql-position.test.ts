import { describe, expect, it } from 'vitest'
import { locateInSql } from './sql-position.ts'

describe('locateInSql', () => {
  it('maps offsets to line/column and returns the line text', () => {
    const sql = 'SELECT 1\nFROM nope\nWHERE x'
    expect(locateInSql(sql, 1)).toEqual({ line: 1, column: 1, text: 'SELECT 1' })
    expect(locateInSql(sql, 'SELECT 1\nFROM '.length + 1)).toEqual({ line: 2, column: 6, text: 'FROM nope' })
    expect(locateInSql(sql, sql.length + 1)).toEqual({ line: 3, column: 8, text: 'WHERE x' })
  })

  it('rejects out-of-range offsets', () => {
    expect(locateInSql('SELECT 1', 0)).toBeNull()
    expect(locateInSql('SELECT 1', 50)).toBeNull()
  })
})
