import type { ReferenceCheck } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { locale } from '@/config/locale-screens.ts'
import { orphansText, referenceOverlay, type TableCheck } from './reference-overlay.ts'

const t = locale.designer.refCheck
const check = (name: string, orphans: number): ReferenceCheck => ({
  name,
  columns: ['user_id'],
  refNamespace: { database: 'shop' },
  refTable: 'users',
  refColumns: ['id'],
  orphans,
  sql: 'SELECT …',
})
const checks = new Map<string, TableCheck>([
  ['posts', [check('fk_posts_user', 3), check('fk_posts_cat', 0)]],
  ['logs', 'failed'],
])

describe('referenceOverlay', () => {
  const overlay = referenceOverlay(checks)

  it('lights and badges only the keys with rows whose parent is missing', () => {
    const key = relationKey({ table: 'posts', name: 'fk_posts_user' })
    expect([...overlay.relations]).toEqual([[key, 'delete']])
    expect([...(overlay.relationBadges ?? [])]).toEqual([[key, t.orphans(3)]])
  })

  it('adds to the picture without fading the rest, and lights no table', () => {
    expect(overlay.fade).toBe(false)
    expect(overlay.tables.size).toBe(0)
  })
})

describe('orphansText', () => {
  it('gives the count, that the table could not be checked, or nothing before the check', () => {
    expect(orphansText(checks, 'posts', 'fk_posts_user')).toBe('3')
    expect(orphansText(checks, 'posts', 'fk_posts_cat')).toBe('0')
    expect(orphansText(checks, 'logs', 'fk_logs_x')).toBe(t.failed)
    expect(orphansText(checks, 'orders', 'fk')).toBeNull()
    expect(orphansText(checks, 'posts', 'gone')).toBeNull()
  })
})
