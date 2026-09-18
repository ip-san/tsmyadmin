import type { ExportTemplate } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { applyTemplate, templatesFor } from './export-templates.ts'

const template = (parts: Partial<ExportTemplate>): ExportTemplate => ({
  id: '',
  name: 'nightly',
  at: 1,
  database: 'shop',
  tables: [],
  options: {
    format: 'sql',
    structure: true,
    dropTable: true,
    data: true,
    bom: true,
    csvSafe: false,
    routines: true,
    stripDefiner: false,
  },
  ...parts,
})

describe('export templates', () => {
  it('shows only the templates of the namespace being looked at', () => {
    const all = [
      template({ name: 'here' }),
      template({ name: 'other db', database: 'blog' }),
      template({ name: 'other schema', schema: 'sales' }),
    ]
    expect(templatesFor(all, 'shop', undefined).map((t) => t.name)).toEqual(['here'])
    expect(templatesFor(all, 'shop', 'sales').map((t) => t.name)).toEqual(['other schema'])
  })

  it('leaves out tables that no longer exist, and names them', () => {
    expect(applyTemplate(template({ tables: ['users', 'gone'] }), ['users', 'posts'])).toEqual({
      tables: ['users'],
      missing: ['gone'],
    })
    // No tables means the whole database, which is still true however the database has changed.
    expect(applyTemplate(template({ tables: [] }), ['users'])).toEqual({ tables: [], missing: [] })
  })
})
