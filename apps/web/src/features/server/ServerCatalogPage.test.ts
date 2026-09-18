import { describe, expect, it } from 'vitest'
import { filterRows } from './ServerCatalogPage.tsx'

describe('filterRows', () => {
  const rows = [
    ['utf8mb4', 'utf8mb4_bin', ''],
    ['latin1', 'latin1_swedish_ci', 'Yes'],
    ['ucs2', null, null],
  ]

  it('keeps rows with any cell containing the text, ignoring case and empty cells', () => {
    expect(filterRows(rows, 'BIN')).toEqual([rows[0]])
    expect(filterRows(rows, 'yes')).toEqual([rows[1]])
    expect(filterRows(rows, 'ucs')).toEqual([rows[2]])
  })

  it('keeps everything for an empty or blank filter', () => {
    expect(filterRows(rows, '')).toBe(rows)
    expect(filterRows(rows, '   ')).toBe(rows)
  })
})
