import { describe, expect, it } from 'vitest'
import { columnsField, csvCharsValid, DEFAULT_IMPORT_OPTIONS, detectFormat, importFields } from './import-options.ts'

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
      skipBlank: '1',
      sheet: 'Sheet2',
      odsPercent: 'fraction',
      odsCurrency: 'number',
      odsDate: 'iso',
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

describe('the choices of a rows import', () => {
  it('sends the column mapping as a list that keeps its blanks, and not when a table is made', () => {
    expect(columnsField('id, name, , email')).toBe('["id","name","","email"]')
    expect(columnsField('  ')).toBeUndefined()
    const mapped = { ...DEFAULT_IMPORT_OPTIONS, columns: 'a,,b' }
    expect(importFields('csv', mapped)).toMatchObject({ columns: '["a","","b"]', skipBlank: '1', lineEnd: 'auto' })
    expect(importFields('csv', { ...mapped, createTable: true })).not.toHaveProperty('columns')
    expect(importFields('sql', mapped)).not.toHaveProperty('columns')
  })
  it('sends the spreadsheet reading choices for ODS only, the line ending for CSV only', () => {
    const o = { ...DEFAULT_IMPORT_OPTIONS, lineEnd: 'lf' as const, odsPercent: 'text' as const, skipBlank: false }
    expect(importFields('ods', o)).toMatchObject({ odsPercent: 'text', odsCurrency: 'number', skipBlank: '0' })
    expect(importFields('ods', o)).not.toHaveProperty('lineEnd')
    expect(importFields('csv', o)).toMatchObject({ lineEnd: 'lf' })
    expect(importFields('csv', o)).not.toHaveProperty('odsPercent')
    expect(importFields('xml', o)).not.toHaveProperty('odsPercent')
  })
})
