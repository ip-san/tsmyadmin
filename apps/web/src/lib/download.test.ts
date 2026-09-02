import { describe, expect, it } from 'vitest'
import { safeFilename } from './download.ts'

describe('safeFilename', () => {
  it('keeps letters, digits, underscore and dash; replaces the rest', () => {
    expect(safeFilename('users', 'csv')).toBe('users.csv')
    expect(safeFilename('文 1 / SELECT *', 'json')).toBe('文_1_SELECT.json')
    expect(safeFilename('///', 'csv')).toBe('result.csv')
  })
})
