import { ExportOptionsSchema, ExportQuerySchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { exportUrl } from './export-url.ts'

const options = (over: Record<string, unknown> = {}) => ExportOptionsSchema.parse(over)
const queryOf = (url: string) => Object.fromEntries(new URL(url, 'http://x').searchParams)

describe('exportUrl', () => {
  it('encodes database, schema and table list', () => {
    const url = exportUrl({
      db: 'my db',
      schema: 'app',
      tables: ['a', 'b,c'],
      ...options({ format: 'csv', structure: false, bom: false }),
    })
    expect(url.startsWith('/api/databases/my%20db/export?schema=app&tables=a%2Cb%252Cc&format=csv&structure=0&')).toBe(
      true
    )
  })

  it('omits tables when exporting everything', () => {
    const url = exportUrl({
      db: 'x',
      tables: [],
      ...options({ dropTable: false, routines: false, stripDefiner: true }),
    })
    expect(queryOf(url)).toMatchObject({ format: 'sql', dropTable: '0', routines: '0', stripDefiner: '1' })
    expect(queryOf(url).tables).toBeUndefined()
  })

  it('carries every choice in a form the endpoint accepts, and reads back as what was chosen', () => {
    const chosen = options({
      format: 'ods',
      compress: 'zip',
      filePerTable: true,
      filename: '@DATABASE@-%Y%m%d',
      charset: 'cp932',
      statement: 'replace',
      columnNames: false,
      extended: false,
      maxQuery: 5000,
      ignore: true,
      utc: true,
      transaction: true,
      viewsAsTables: true,
      createDatabase: true,
      ifNotExists: true,
      comments: false,
      lockTables: true,
      rowOffset: 10,
      rowLimit: 25,
    })
    const parsed = ExportQuerySchema.parse(queryOf(exportUrl({ db: 'x', tables: [], ...chosen })))
    expect(parsed).toMatchObject({
      format: 'ods',
      compress: 'zip',
      filePerTable: '1',
      filename: '@DATABASE@-%Y%m%d',
      charset: 'cp932',
      statement: 'replace',
      columnNames: '0',
      extended: '0',
      maxQuery: 5000,
      ignore: '1',
      utc: '1',
      transaction: '1',
      viewsAsTables: '1',
      createDatabase: '1',
      ifNotExists: '1',
      comments: '0',
      lockTables: '1',
      rowOffset: 10,
      rowLimit: 25,
    })
  })
})
