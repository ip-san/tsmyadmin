import type { RelationDef, SnapshotDiff } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { locale } from '@/config/locale-screens.ts'
import { compareDiagram } from './compare-overlay.ts'

const t = locale.designer.compare
const rel = (table: string, refTable: string): RelationDef => ({
  table,
  name: `fk_${table}_${refTable}`,
  columns: [`${refTable}_id`],
  refNamespace: { database: 'shop' },
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
})
const entry = (name: string) => ({ name, before: null, after: null })
const diff = (shape: SnapshotDiff['shape']): SnapshotDiff => ({
  snapshot: { id: 's1', name: 'before', at: '2026-10-17T00:00:00Z', bytes: 1, objects: 4 },
  shape,
  added: [entry('tags')],
  removed: [entry('posts'), entry('old_view')],
  changed: [entry('users')],
  unchanged: 1,
  unreadable: [],
})
const now = ['users', 'tags', 'logs']
const nowKeys = [rel('logs', 'users')]
const shape = {
  tables: [
    { name: 'users', kind: 'table' as const },
    { name: 'posts', kind: 'table' as const },
    { name: 'old_view', kind: 'view' as const },
    { name: 'logs', kind: 'table' as const },
  ],
  relations: [rel('posts', 'users'), rel('logs', 'users')],
}

describe('compareDiagram', () => {
  it('draws the removed tables again, with the keys the snapshot had for them, but no views', () => {
    const d = compareDiagram(diff(shape), now, nowKeys)
    expect(d.tables).toEqual(['users', 'tags', 'logs', 'posts'])
    expect(d.relations.map((r) => r.name)).toEqual(['fk_logs_users', 'fk_posts_users'])
    expect([...d.overlay.relations]).toEqual([[relationKey(rel('posts', 'users')), 'blocked']])
  })

  it('lights each table by what happened to it, and leaves the unchanged ones to fade', () => {
    const lit = compareDiagram(diff(shape), now, nowKeys).overlay.tables
    expect(lit.get('tags')).toEqual({ tone: 'index', badge: t.added })
    expect(lit.get('posts')).toEqual({ tone: 'blocked', badge: t.removed })
    expect(lit.get('users')).toEqual({ tone: 'nullify', badge: t.changed })
    expect(lit.has('logs')).toBe(false)
  })

  it("draws every removed name without the snapshot's list, and no lines for them", () => {
    const d = compareDiagram(diff(null), now, nowKeys)
    expect(d.tables).toEqual(['users', 'tags', 'logs', 'posts', 'old_view'])
    expect(d.relations).toEqual(nowKeys)
  })

  it('draws a removed table as removed even while the list of tables still has it, and its keys too', () => {
    const d = compareDiagram(diff(shape), [...now, 'posts'], [...nowKeys, rel('posts', 'users')])
    expect(d.tables.filter((n) => n === 'posts')).toHaveLength(1)
    expect(d.overlay.tables.get('posts')?.tone).toBe('blocked')
    expect(d.relations.filter((r) => r.table === 'posts')).toHaveLength(1)
    expect(d.overlay.relations.get(relationKey(rel('posts', 'users')))).toBe('blocked')
  })
})
