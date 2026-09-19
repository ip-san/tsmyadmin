import { describe, expect, it } from 'vitest'
import { csvCharsValid, DEFAULT_IMPORT_OPTIONS, detectFormat, importFields } from './import-options.ts'

describe('detectFormat', () => {
  it('detects by extension, case-insensitively, and looks through .gz', () => {
    expect(detectFormat('dump.SQL')).toBe('sql')
    expect(detectFormat('users.csv')).toBe('csv')
    expect(detectFormat('dump.sql.gz')).toBe('sql')
    expect(detectFormat('sheet.ods')).toBe('ods')
    expect(detectFormat('data.xml')).toBe('xml')
    expect(detectFormat('table.wiki')).toBe('mediawiki')
    expect(detectFormat('notes.txt')).toBeNull()
    expect(detectFormat('all.zip')).toBeNull()
    expect(detectFormat('noext')).toBeNull()
    expect(detectFormat('.gz')).toBeNull()
  })
})

describe('importFields', () => {
  it('sends only what the format uses', () => {
    const o = { ...DEFAULT_IMPORT_OPTIONS, skip: 3, sheet: ' Sheet2 ', noAutoValueOnZero: true }
    expect(importFields('sql', o)).toEqual({
      charset: 'utf-8',
      skip: '3',
      stopOnError: '1',
      ignoreForeignKeys: '0',
      singleTransaction: '0',
      noAutoValueOnZero: '1',
    })
    expect(importFields('ods', o)).toEqual({
      charset: 'utf-8',
      skip: '3',
      onDuplicate: 'error',
      createTable: '0',
      sheet: 'Sheet2',
    })
    expect(importFields('csv', { ...o, skip: 0 })).toMatchObject({ header: '1', nullMarker: '\\N', enclosure: '"' })
  })

  it('refuses a CSV delimiter that is a quote or longer than one character', () => {
    expect(csvCharsValid(DEFAULT_IMPORT_OPTIONS)).toBe(true)
    expect(csvCharsValid({ ...DEFAULT_IMPORT_OPTIONS, delimiter: '"' })).toBe(false)
    expect(csvCharsValid({ ...DEFAULT_IMPORT_OPTIONS, delimiter: '' })).toBe(false)
    expect(csvCharsValid({ ...DEFAULT_IMPORT_OPTIONS, escape: '' })).toBe(false)
  })
})
