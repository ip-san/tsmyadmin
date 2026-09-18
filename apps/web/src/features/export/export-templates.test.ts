import type { ExportTemplate } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { applyTemplate, deleteTemplate, loadTemplates, saveTemplate, templatesFor } from './export-templates.ts'

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
  it('keeps a name of one database apart from the same name in another', () => {
    const store = new Map<string, string>()
    const memory = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    saveTemplate('s', template({ name: 'nightly', database: 'shop' }), memory)
    saveTemplate('s', template({ name: 'nightly', database: 'blog', tables: ['posts'] }), memory)
    expect(loadTemplates('s', 'shop', undefined, memory)).toMatchObject([{ database: 'shop', tables: [] }])
    expect(loadTemplates('s', 'blog', undefined, memory)).toMatchObject([{ tables: ['posts'] }])
    // Deleting one leaves the other alone.
    deleteTemplate('s', 'blog', undefined, 'nightly', memory)
    expect(loadTemplates('s', 'blog', undefined, memory)).toEqual([])
    expect(loadTemplates('s', 'shop', undefined, memory)).toHaveLength(1)
  })

  it('moves a list saved under the old per-server key to its database', () => {
    const store = new Map<string, string>()
    const memory = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    const old = [template({ name: 'nightly', database: 'shop' }), template({ name: 'nightly', database: 'blog' })]
    memory.setItem('tsmyadmin.pref.export.templates.s', JSON.stringify(old))
    expect(loadTemplates('s', 'shop', undefined, memory)).toMatchObject([{ database: 'shop' }])
    expect(loadTemplates('s', 'blog', undefined, memory)).toMatchObject([{ database: 'blog' }])
    // Moved, not copied: the old key is gone.
    expect(memory.getItem('tsmyadmin.pref.export.templates.s')).toBeNull()
  })

  it('keeps the order of several templates of one database while moving them', () => {
    const store = new Map<string, string>()
    const memory = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    // As the old list held them: newest first.
    const old = ['newest', 'middle', 'oldest'].map((name) => template({ name }))
    memory.setItem('tsmyadmin.pref.export.templates.s', JSON.stringify(old))
    expect(loadTemplates('s', 'shop', undefined, memory).map((t) => t.name)).toEqual(['newest', 'middle', 'oldest'])
  })

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
