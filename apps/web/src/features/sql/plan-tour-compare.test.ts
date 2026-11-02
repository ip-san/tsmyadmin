import type { ExplainResult, PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { chaptersOf } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { relation } from '@/test/schema-fixtures.ts'
import { planTour } from './plan-tour.ts'
import type { CompareRow } from './use-assumed-compare.ts'

const t = locale.planTour
const p = locale.plan
const node = (n: Partial<PlanNode>): PlanNode => ({
  op: 'Step',
  table: null,
  alias: null,
  index: null,
  indexColumns: [],
  access: null,
  covering: false,
  estRows: null,
  cost: null,
  detail: null,
  children: [],
  ...n,
})
const keys = [relation('items', ['order_id'], 'orders', { name: 'fk_items_order' })]
const fullOrders = node({ op: 'Seq Scan', table: 'orders', access: 'fullScan', estRows: 40, detail: '(level = 3)' })
const fullItems = node({ op: 'Seq Scan', table: 'items', access: 'fullScan', estRows: 90, detail: "(kind = 'x')" })
const byLevel = node({ op: 'Index Scan', table: 'orders', index: 'idx_orders_level', access: 'lookup', estRows: 40 })
const join = (cost: number, ...children: PlanNode[]) => node({ op: 'Hash Join', cost, children })
const result = (plan: PlanNode, assumed: string[]): ExplainResult => ({ plan, raw: '', rawTruncated: false, assumed })

// No index on either condition: each table read in full (cost 900). Assumed alone, the server would read orders
// through its candidate (cost 120) but not items through its own; together, the same as orders alone.
const before = result(join(900, fullOrders, fullItems), [])
const level = { table: 'orders', columns: ['level'], name: 'idx_orders_level', reason: 'filter' as const }
const kind = { table: 'items', columns: ['kind'], name: 'idx_items_kind', reason: 'filter' as const }
const rows: CompareRow[] = [
  { indexes: [level], result: result(join(120, byLevel, fullItems), ['idx_orders_level']), error: null },
  { indexes: [kind], result: result(join(900, fullOrders, fullItems), []), error: null },
  { indexes: [level, kind], result: result(join(120, byLevel, fullItems), ['idx_orders_level']), error: null },
]
const tour = (compared: CompareRow[]) =>
  planTour({ plan: before.plan, relations: keys, compare: { before, rows: compared } })

describe('planTour with the candidates compared', () => {
  it('tells each candidate alone, then all together, as a chapter of its own before the summary', () => {
    const { diagram, scenes } = tour(rows)
    const at = scenes.findIndex((s) => s.title === t.compareOpenTitle)
    expect(scenes.slice(at).map((s) => s.title)).toEqual([
      t.compareOpenTitle,
      t.compareOneTitle('idx_orders_level'),
      t.compareOneTitle('idx_items_kind'),
      t.compareAllTitle,
      t.endTitle,
    ])
    expect(chaptersOf(scenes).map((c) => c.title)).toEqual([t.chapters.reads, t.chapters.compare])
    expect(chaptersOf(scenes).at(-1)?.from).toBe(at)
    // Said from the start that the last chapter is of the candidates, none built.
    expect(scenes[0]?.notes).toEqual([t.compareIntro(2)])
    const [open, one, other, all] = scenes.slice(at)
    expect(open?.text).toBe(t.compareOpen(2, 900))
    expect(open?.notes).toEqual([p.compareNote])
    expect(open?.frame).toEqual(['orders', 'items'])
    // Every candidate's columns marked, on the diagram too.
    expect([...(open?.overlay.columns.get('orders') ?? [])]).toEqual(['level'])
    expect([...(open?.overlay.columns.get('items') ?? [])]).toEqual(['kind'])
    expect(diagram.columns.get('items')).toContain('kind')
    // Alone: the table read as now, then as with it, and the costs.
    expect(one?.text).toBe(t.compareOne('orders', p.assumeRead(null, 40), p.assumeRead('idx_orders_level', 40), true))
    expect(one?.frame).toEqual(['orders'])
    expect(one?.overlay.tables.get('orders')).toEqual({ tone: 'index', badge: 'idx_orders_level' })
    expect(one?.notes).toEqual([p.assumeCost(900, 120)])
    expect(one?.hints).toBeUndefined()
    expect(other?.text).toBe(t.compareOne('items', p.assumeRead(null, 90), p.assumeRead(null, 90), false))
    expect(other?.hints).toEqual([p.assumeUnused('idx_items_kind')])
    // Together: every candidate's table, the ones it would use lit, and the one it would not said.
    expect(all?.text).toBe(t.compareAll(['idx_orders_level'], ['idx_items_kind']))
    expect(all?.frame).toEqual(['orders', 'items'])
    expect(all?.pulse).toEqual(['orders'])
    expect(all?.notes).toEqual([p.assumeCost(900, 120)])
    expect(all?.hints).toEqual([t.compareUnusedHint(['idx_items_kind'])])
  })

  it('names a candidate the server could not estimate, and tells the others', () => {
    const failed: CompareRow[] = [rows[0] as CompareRow, { indexes: [kind], result: null, error: new Error('x') }]
    const scenes = tour(failed).scenes
    const open = scenes.find((s) => s.title === t.compareOpenTitle)
    expect(open?.notes).toEqual([p.compareNote, t.compareFailedNote(['idx_items_kind'])])
    expect(scenes.some((s) => s.title === t.compareOneTitle('idx_items_kind'))).toBe(false)
    expect(scenes.some((s) => s.title === t.compareOneTitle('idx_orders_level'))).toBe(true)
    // All together failed too: named as such.
    const none = tour([rows[0] as CompareRow, rows[1] as CompareRow, { ...(rows[2] as CompareRow), result: null }])
    expect(none.scenes.find((s) => s.title === t.compareOpenTitle)?.notes).toEqual([
      p.compareNote,
      t.compareFailedNote([t.compareAllTitle]),
    ])
    expect(none.scenes.some((s) => s.title === t.compareAllTitle)).toBe(false)
  })

  it('says no candidate is wasted where all together uses every one, and none is used where none is', () => {
    const both = result(join(60, byLevel, node({ ...fullItems, index: 'idx_items_kind', access: 'lookup' })), [
      'idx_orders_level',
      'idx_items_kind',
    ])
    const used = tour([
      rows[0] as CompareRow,
      rows[1] as CompareRow,
      { indexes: [level, kind], result: both, error: null },
    ])
    const all = used.scenes.find((s) => s.title === t.compareAllTitle)
    expect(all?.text).toBe(t.compareAll(['idx_orders_level', 'idx_items_kind'], []))
    expect(all?.hints).toBeUndefined()
    expect(all?.pulse).toEqual(['orders', 'items'])
    const unused = tour([{ ...(rows[2] as CompareRow), result: result(before.plan, []) }])
    const nothing = unused.scenes.find((s) => s.title === t.compareAllTitle)
    expect(nothing?.text).toBe(t.compareAll([], ['idx_orders_level', 'idx_items_kind']))
    // Each alone already says it would not be used: the together scene does not say it again.
    expect(nothing?.hints).toBeUndefined()
  })

  it('tells no comparison where none was made', () => {
    const scenes = planTour({ plan: before.plan, relations: keys }).scenes
    expect(scenes.some((s) => s.title === t.compareOpenTitle)).toBe(false)
  })
})
