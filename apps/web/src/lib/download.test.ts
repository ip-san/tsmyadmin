import { describe, expect, it } from 'vitest'
import { safeFilename } from './download.ts'

describe('safeFilename', () => {
  it('keeps letters, digits, underscore and dash; replaces the rest', () => {
    expect(safeFilename('users', 'csv')).toBe('users.csv')
    expect(safeFilename('文 1 / SELECT *', 'json')).toBe('文_1_SELECT.json')
    expect(safeFilename('///', 'csv')).toBe('result.csv')
  })

  it('cuts a long label at 60, and cuts it before a part named after it, so that two parts are never one name', () => {
    expect(safeFilename('x'.repeat(80), 'csv')).toBe(`${'x'.repeat(60)}.csv`)
    const title = `Table presentation: ${'a_long_table_name_'.repeat(3)}`
    const one = safeFilename(title, 'mp4', '1 The table and its primary key')
    const two = safeFilename(title, 'mp4', '2 The tables one foreign key away')
    expect(one).toMatch(/^Table_presentation_a_long.*_1_The_table_and_its_primary_key\.mp4$/)
    expect(two).toMatch(/_2_The_tables_one_foreign_key_away\.mp4$/)
    expect(one.length - '.mp4'.length).toBeLessThanOrEqual(60)
    expect(safeFilename('Map', 'mp4', '2 Checks')).toBe('Map_2_Checks.mp4')
  })
})
