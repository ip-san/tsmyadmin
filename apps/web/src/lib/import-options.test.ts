import { describe, expect, it } from 'vitest'
import {
  columnsField,
  csvCharsValid,
  DEFAULT_IMPORT_OPTIONS,
  detectFormat,
  type ImportOptions,
  importFields,
  isRowsFormat,
} from './import-options.ts'

const opts = (extra: Partial<ImportOptions> = {}): ImportOptions => ({ ...DEFAULT_IMPORT_OPTIONS, ...extra })

describe('detectFormat', () => {
  it('detects by extension, case-insensitively, and looks through .gz', () => {
    const cases: [string, string | null][] = [
      ['dump.SQL', 'sql'],
      ['users.csv', 'csv'],
      ['dump.sql.gz', 'sql'],
      ['data.CSV.GZ', 'csv'],
      ['sheet.ods', 'ods'],
      ['data.xml', 'xml'],
      ['table.wiki', 'mediawiki'],
      ['page.mediawiki', 'mediawiki'],
      ['.sql', 'sql'],
      ['notes.txt', null],
      ['all.zip', null],
      ['noext', null],
      ['.gz', null],
      ['a.gz', null],
      ['x.tar.gz', null],
      ['', null],
    ]
    for (const [name, format] of cases) expect(detectFormat(name), name).toBe(format)
  })

  it('shares the row choices among all formats but SQL', () => {
    expect(isRowsFormat('sql')).toBe(false)
    for (const f of ['csv', 'ods', 'xml', 'mediawiki'] as const) expect(isRowsFormat(f), f).toBe(true)
  })
})

describe('importFields', () => {
  it('sends only what the format uses', () => {
    const o = opts({ skip: 3, sheet: ' Sheet2 ', noAutoValueOnZero: true })
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

  it("sends a SQL file's four switches as 1 or 0, and the lines to skip only when there are some", () => {
    expect(importFields('sql', opts())).toEqual({
      charset: 'utf-8',
      stopOnError: '1',
      ignoreForeignKeys: '0',
      singleTransaction: '0',
      noAutoValueOnZero: '0',
    })
    expect(
      importFields('sql', opts({ stopOnError: false, ignoreForeignKeys: true, singleTransaction: true }))
    ).toMatchObject({ stopOnError: '0', ignoreForeignKeys: '1', singleTransaction: '1' })
    expect(importFields('xml', opts({ skip: 0 }))).not.toHaveProperty('skip')
  })

  it('sends the whole CSV form, and the separators as typed', () => {
    expect(importFields('csv', opts())).toEqual({
      charset: 'utf-8',
      onDuplicate: 'error',
      createTable: '0',
      skipBlank: '1',
      lineEnd: 'auto',
      header: '1',
      nullMarker: '\\N',
      delimiter: ',',
      enclosure: '"',
      escape: '"',
    })
    expect(
      importFields(
        'csv',
        opts({ header: false, delimiter: ';', enclosure: "'", escape: '\\', nullMarker: 'NULL', lineEnd: 'lf' })
      )
    ).toMatchObject({
      header: '0',
      delimiter: ';',
      enclosure: "'",
      escape: '\\',
      nullMarker: 'NULL',
      lineEnd: 'lf',
    })
  })

  it('refuses a CSV delimiter that is a quote or longer than one character', () => {
    expect(csvCharsValid(DEFAULT_IMPORT_OPTIONS)).toBe(true)
    expect(csvCharsValid(opts({ delimiter: '\t' }))).toBe(true)
    expect(csvCharsValid(opts({ delimiter: ';', enclosure: "'", escape: '\\' }))).toBe(true)
    for (const bad of [
      { delimiter: '' },
      { delimiter: ',,' },
      { delimiter: '"' },
      { delimiter: '\n' },
      { delimiter: '\r' },
      { enclosure: '' },
      { enclosure: '""' },
      { escape: '' },
      { escape: '\\\\' },
    ]) {
      expect(csvCharsValid(opts(bad)), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('the choices of a rows import', () => {
  it('sends the column mapping as a list that keeps its blanks, and not when a table is made', () => {
    expect(columnsField('id, name, , email')).toBe('["id","name","","email"]')
    expect(columnsField(' a , b ,c')).toBe('["a","b","c"]')
    expect(columnsField('a')).toBe('["a"]')
    expect(columnsField('')).toBeUndefined()
    expect(columnsField('  ')).toBeUndefined()
    const mapped = opts({ columns: 'a,,b' })
    expect(importFields('csv', mapped)).toMatchObject({ columns: '["a","","b"]', skipBlank: '1', lineEnd: 'auto' })
    expect(importFields('csv', { ...mapped, createTable: true })).not.toHaveProperty('columns')
    expect(importFields('sql', mapped)).not.toHaveProperty('columns')
  })

  it('sends the duplicate and blank-row choices for any rows format, and the CSV and ODS parts for no other', () => {
    expect(importFields('xml', opts({ onDuplicate: 'replace', skipBlank: false, createTable: false }))).toEqual({
      charset: 'utf-8',
      onDuplicate: 'replace',
      createTable: '0',
      skipBlank: '0',
    })
    expect(importFields('xml', opts())).not.toHaveProperty('header')
    expect(importFields('xml', opts())).not.toHaveProperty('odsPercent')
  })

  it('sends the sheet, trimmed, for any rows format, and not when it is blank', () => {
    expect(importFields('mediawiki', opts({ sheet: '  Sheet1 ' }))).toMatchObject({ sheet: 'Sheet1' })
    expect(importFields('mediawiki', opts({ sheet: '   ' }))).not.toHaveProperty('sheet')
  })

  it('sends the spreadsheet reading choices for ODS only, the line ending for CSV only', () => {
    const o = opts({ lineEnd: 'lf', odsPercent: 'text', skipBlank: false })
    expect(importFields('ods', o)).toMatchObject({ odsPercent: 'text', odsCurrency: 'number', skipBlank: '0' })
    expect(importFields('ods', o)).not.toHaveProperty('lineEnd')
    expect(importFields('ods', opts({ odsPercent: 'text', odsCurrency: 'text', odsDate: 'text' }))).toMatchObject({
      odsPercent: 'text',
      odsCurrency: 'text',
      odsDate: 'text',
    })
    expect(importFields('csv', o)).toMatchObject({ lineEnd: 'lf' })
    expect(importFields('csv', o)).not.toHaveProperty('odsPercent')
    expect(importFields('xml', o)).not.toHaveProperty('odsPercent')
  })
})
