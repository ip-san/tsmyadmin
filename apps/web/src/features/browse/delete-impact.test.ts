import type { DeleteImpact, RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { locale } from '@/config/locale-screens.ts'
import { impactRelations, impactSteps, impactTables } from './delete-impact.ts'

const t = locale.deleteImpact
const step = (s: Partial<DeleteImpact['steps'][number]>): DeleteImpact['steps'][number] => ({
  depth: 1,
  table: 'orders',
  constraint: 'fk_orders_user',
  columns: ['user_id'],
  refTable: 'users',
  action: 'cascade',
  rows: 2,
  ...s,
})
const impact: DeleteImpact = {
  table: 'users',
  rows: 1,
  blocked: true,
  capped: false,
  steps: [
    step({}),
    step({ table: 'notes', constraint: 'fk_notes_user', action: 'setNull', rows: 1 }),
    step({ table: 'audit', constraint: 'fk_audit_user', action: 'restrict', rows: 0 }),
    step({
      depth: 2,
      table: 'items',
      constraint: 'fk_items_order',
      columns: ['order_id'],
      refTable: 'orders',
      rows: 3,
    }),
    step({
      depth: 2,
      table: 'items',
      constraint: 'fk_items_order2',
      columns: ['order2_id'],
      refTable: 'orders',
      rows: 4,
    }),
    step({ depth: 2, table: 'locks', constraint: 'fk_locks_order', refTable: 'orders', action: 'noAction', rows: 5 }),
  ],
}

describe('impactSteps', () => {
  const steps = impactSteps(impact)

  it('starts at the chosen rows, then tells one step per depth', () => {
    expect(steps).toHaveLength(3)
    expect(steps[0]).toEqual({ text: t.start('users', 1), tables: [{ name: 'users', tone: 'focus', badge: '1' }] })
  })

  it('says what every key followed does, and lights only those with rows referring', () => {
    const first = steps[1]
    expect(first?.text).toBe(
      `${t.depth(1)}: ${t.cascade('orders', 2, 'fk_orders_user')} / ${t.setNull('notes', 1, 'user_id', 'fk_notes_user')} / ${t.none('audit', 'fk_audit_user')}`
    )
    expect(first?.tables?.map((x) => [x.name, x.tone])).toEqual([
      ['orders', 'delete'],
      ['notes', 'nullify'],
    ])
    expect(first?.relations).toEqual([
      { key: relationKey({ table: 'orders', name: 'fk_orders_user' }), tone: 'delete' },
      { key: relationKey({ table: 'notes', name: 'fk_notes_user' }), tone: 'nullify' },
    ])
    expect(first?.columns).toEqual([
      { table: 'orders', column: 'user_id' },
      { table: 'notes', column: 'user_id' },
    ])
  })

  it('adds up a table reached along two keys at one depth, and marks a refusing key as blocked', () => {
    const second = steps[2]
    expect(second?.tables?.filter((x) => x.name === 'items').map((x) => x.badge)).toEqual(['7', '7'])
    expect(second?.tables?.find((x) => x.name === 'locks')?.tone).toBe('blocked')
    expect(second?.text).toContain(t.refuse('locks', 5, 'fk_locks_order'))
  })

  it('says SET DEFAULT in its own words', () => {
    const [, only] = impactSteps({ ...impact, steps: [step({ action: 'setDefault' })] })
    expect(only?.text).toBe(`${t.depth(1)}: ${t.setDefault('orders', 2, 'user_id', 'fk_orders_user')}`)
  })
})

describe('impactTables / impactRelations', () => {
  it('names the deleted table first', () => {
    expect(impactTables(impact).slice(0, 2)).toEqual(['users', 'orders'])
  })

  it('keeps only the keys the walk followed', () => {
    const rel = (table: string, name: string): RelationDef => ({
      table,
      name,
      columns: ['x'],
      refNamespace: { database: 'app' },
      refTable: 'users',
      refColumns: ['id'],
      onUpdate: null,
      onDelete: 'CASCADE',
    })
    const kept = impactRelations(impact, [rel('orders', 'fk_orders_user'), rel('orders', 'fk_orders_other')])
    expect(kept.map((r) => r.name)).toEqual(['fk_orders_user'])
  })
})
