import { describe, expect, it } from 'vitest'
import { detectFormat } from './ImportForm.tsx'

describe('detectFormat', () => {
  it('detects by extension, case-insensitively', () => {
    expect(detectFormat('dump.SQL')).toBe('sql')
    expect(detectFormat('users.csv')).toBe('csv')
    expect(detectFormat('notes.txt')).toBeNull()
    expect(detectFormat('noext')).toBeNull()
  })
})
