import { describe, expect, it } from 'vitest'
import { exportUrl } from './export-url.ts'

describe('exportUrl', () => {
  it('encodes database, schema and table list', () => {
    expect(
      exportUrl({
        db: 'my db',
        schema: 'app',
        tables: ['a', 'b,c'],
        format: 'csv',
        structure: false,
        data: true,
        bom: false,
      })
    ).toBe('/api/databases/my%20db/export?schema=app&tables=a%2Cb%2Cc&format=csv&structure=0&data=1&bom=0')
  })

  it('omits tables when exporting everything', () => {
    expect(exportUrl({ db: 'x', tables: [], format: 'sql', structure: true, data: true, bom: true })).toBe(
      '/api/databases/x/export?format=sql&structure=1&data=1&bom=1'
    )
  })
})
