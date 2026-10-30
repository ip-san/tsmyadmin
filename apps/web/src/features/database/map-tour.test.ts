import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { chaptersOf } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { relation } from '@/test/schema-fixtures.ts'
import type { DatabaseMap } from './database-map.ts'
import { joinPaths } from './join-path.ts'
import { tourScenes } from './map-tour.ts'

const t = locale.mapTour
const g = locale.tour

// users ← orders ← lines; logs on their own.
const toUsers = relation('orders', ['user_id'], 'users')
const toOrders = relation('lines', ['order_id'], 'orders')
const relations = [toUsers, toOrders]

const empty = (): DatabaseMap => ({
  tables: 4,
  views: 0,
  roles: { master: [], middle: [], detail: [], junction: [], tree: [], isolated: [] },
  hubs: [],
  noPrimaryKey: [],
  unindexedKeys: [],
  keyTypes: [],
  nameTypes: [],
})

const shop = (): DatabaseMap => ({
  ...empty(),
  roles: { ...empty().roles, master: ['users'], middle: ['orders'], detail: ['lines'], isolated: ['logs'] },
  hubs: [
    { table: 'orders', referredBy: 1 },
    { table: 'users', referredBy: 1 },
  ],
})

describe('tourScenes', () => {
  it('opens on the whole picture coming in, tells each role in order, then the hubs, and ends on the whole again', () => {
    const scenes = tourScenes({ name: 'shop', map: shop(), relations })
    expect(scenes.map((s) => s.title)).toEqual([
      'shop',
      t.roleTitle(t.roles.master, 1),
      t.roleTitle(t.roles.middle, 1),
      t.roleTitle(t.roles.detail, 1),
      t.roleTitle(t.roles.isolated, 1),
      t.hubTitle('orders', 1),
      t.hubTitle('users', 1),
      t.endTitle,
    ])
    expect(scenes[0]).toMatchObject({ text: t.overview(4, 2), frame: [], pulse: [] })
    expect(chaptersOf(scenes)).toEqual([
      { title: t.chapters.roles, from: 0, to: 5 },
      { title: t.chapters.hubs, from: 5, to: 8 },
    ])
    expect(scenes[0]?.overlay).toMatchObject({ enter: true, fade: false })
    expect(scenes.at(-1)?.overlay).toMatchObject({ enter: false, fade: false })
    expect(scenes.at(-1)?.text).toBe(
      t.end([
        t.roleCount(t.roleShort.master, 1),
        t.roleCount(t.roleShort.middle, 1),
        t.roleCount(t.roleShort.detail, 1),
        t.roleCount(t.roleShort.isolated, 1),
      ])
    )
  })

  it("frames a role's tables with the tables their keys reach, and lets those keys flow", () => {
    const [, master, middle, , isolated] = tourScenes({ name: 'shop', map: shop(), relations })
    expect(master?.frame).toEqual(['users', 'orders'])
    expect(master?.pulse).toEqual(['users'])
    expect([...(master?.overlay.tables.keys() ?? [])]).toEqual(['users'])
    expect([...(master?.overlay.flow ?? [])]).toEqual([[relationKey(toUsers), 'forward']])
    expect(master?.text).toBe(`${t.roleText.master}${g.stop}users`)
    expect(middle?.frame).toEqual(['orders', 'users', 'lines'])
    expect([...(middle?.overlay.relations.keys() ?? [])]).toEqual([relationKey(toUsers), relationKey(toOrders)])
    // Joined to nothing: it alone, and no line.
    expect(isolated?.frame).toEqual(['logs'])
    expect(isolated?.overlay.flow?.size).toBe(0)
  })

  it('says a few names of a long list and counts the rest', () => {
    const many = Array.from({ length: 9 }, (_, i) => `t${i}`)
    const [, role] = tourScenes({
      name: 'x',
      map: { ...empty(), roles: { ...empty().roles, isolated: many } },
      relations: [],
    })
    expect(role?.text).toBe(`${t.roleText.isolated}${g.stop}${g.names(many.slice(0, 6), 3)}`)
  })

  it('tells at most three hubs, each with the tables that point at it and the columns joined', () => {
    const hubs = ['a', 'b', 'c', 'd'].map((table) => ({ table, referredBy: 1 }))
    const keys = hubs.map((h) => relation(`${h.table}_child`, [`${h.table}_id`], h.table))
    const scenes = tourScenes({ name: 'x', map: { ...empty(), hubs }, relations: keys })
    const told = scenes.filter((s) => s.title.startsWith('a') || /^[bcd]:/.test(s.title))
    expect(told.map((s) => s.title)).toEqual([t.hubTitle('a', 1), t.hubTitle('b', 1), t.hubTitle('c', 1)])
    const [a] = told
    expect(a?.frame).toEqual(['a', 'a_child'])
    expect(a?.overlay.tables.get('a')).toEqual({ tone: 'focus', badge: t.referredBy(1) })
    expect(a?.overlay.tables.get('a_child')).toEqual({ tone: 'index', badge: undefined })
    expect(a?.overlay.columns.get('a_child')).toEqual(new Set(['a_id']))
    expect(a?.overlay.columns.get('a')).toEqual(new Set(['id']))
    expect(a?.text).toBe(t.hubText('a', 'a_child'))
  })

  it('tells what to look at as a chapter of its own, with the summary', () => {
    const scenes = tourScenes({ name: 'x', map: { ...shop(), noPrimaryKey: ['logs'] }, relations })
    expect(chaptersOf(scenes).at(-1)).toEqual({ title: t.chapters.checks, from: scenes.length - 2, to: scenes.length })
    expect(scenes.at(-2)?.title).toBe(t.noPrimaryKeyTitle(1))
  })

  it('walks a path one step a scene, flowing the way it is walked', () => {
    const hops = joinPaths(relations, 'users', 'lines').paths[0] ?? []
    const scenes = tourScenes({ name: 'x', map: empty(), relations, path: { from: 'users', to: 'lines', hops } })
    const walk = scenes.filter((s) => s.title === t.pathTitle('users', 'lines'))
    expect(walk).toHaveLength(2)
    // The way is a chapter of its own, after the opening; the summary goes with it.
    expect(chaptersOf(scenes)).toEqual([
      { title: t.chapters.roles, from: 0, to: 1 },
      { title: t.chapters.path, from: 1, to: 4 },
    ])
    const [first, second] = walk
    // users → orders goes against the key (orders refers to users).
    expect(first?.frame).toEqual(['users', 'orders'])
    expect([...(first?.overlay.flow ?? [])]).toEqual([[relationKey(toUsers), 'back']])
    expect(first?.text).toBe(`${t.pathStep(1, 2)}${t.pathKey('orders', 'user_id', 'users', 'id')}`)
    expect(first?.pulse).toEqual(['orders'])
    // What was walked stays lit; only the step taken flows.
    expect(second?.frame).toEqual(['users', 'orders', 'lines'])
    expect([...(second?.overlay.relations.keys() ?? [])]).toEqual([relationKey(toUsers), relationKey(toOrders)])
    expect([...(second?.overlay.flow ?? [])]).toEqual([[relationKey(toOrders), 'back']])
    expect(second?.overlay.tables.get('users')?.tone).toBe('focus')
    expect(second?.overlay.tables.get('orders')?.tone).toBe('index')
    expect(second?.overlay.tables.get('lines')?.tone).toBe('focus')
  })

  it('flows with the key when the path walks from the table that refers', () => {
    const hops = joinPaths(relations, 'orders', 'users').paths[0] ?? []
    const scenes = tourScenes({ name: 'x', map: empty(), relations, path: { from: 'orders', to: 'users', hops } })
    const step = scenes.find((s) => s.title === t.pathTitle('orders', 'users'))
    expect([...(step?.overlay.flow ?? [])]).toEqual([[relationKey(toUsers), 'forward']])
  })

  it('names what to look at, a scene for each that has something', () => {
    const map: DatabaseMap = {
      ...empty(),
      noPrimaryKey: ['logs'],
      unindexedKeys: [{ table: 'orders', key: toUsers.name, columns: ['user_id'], refTable: 'users' }],
      keyTypes: [
        {
          table: 'lines',
          key: toOrders.name,
          column: 'order_id',
          type: 'text',
          refTable: 'orders',
          refColumn: 'id',
          refType: 'int',
        },
      ] as DatabaseMap['keyTypes'],
    }
    const scenes = tourScenes({ name: 'x', map, relations })
    const [pk, unindexed, types] = scenes.slice(1, -1)
    expect(pk?.title).toBe(t.noPrimaryKeyTitle(1))
    expect(pk?.overlay.tables.get('logs')).toEqual({ tone: 'blocked', badge: t.noPrimaryKeyBadge })
    expect(unindexed?.title).toBe(t.unindexedTitle(1))
    expect(unindexed?.text).toBe(`${t.unindexedText}${g.stop}orders（user_id）`)
    expect(unindexed?.frame).toEqual(['orders', 'users'])
    expect(unindexed?.overlay.relations.get(relationKey(toUsers))).toBe('scan')
    expect(types?.title).toBe(t.keyTypesTitle(1))
    expect(types?.overlay.relations.get(relationKey(toOrders))).toBe('nullify')
    expect(types?.overlay.columns.get('orders')).toEqual(new Set(['id']))
  })

  it('leaves out a check whose key is not drawn (into another schema)', () => {
    const map: DatabaseMap = {
      ...empty(),
      unindexedKeys: [{ table: 'orders', key: 'fk_elsewhere', columns: ['x_id'], refTable: 'other' }],
    }
    expect(tourScenes({ name: 'x', map, relations }).map((s) => s.title)).toEqual(['x', t.endTitle])
  })

  it('tells no path when there is none to walk', () => {
    const scenes = tourScenes({ name: 'x', map: empty(), relations, path: { from: 'a', to: 'b', hops: [] } })
    expect(scenes.map((s) => s.title)).toEqual(['x', t.endTitle])
  })

  it('says what a delete does along the keys: on the tables most referred to, and over the whole at the end', () => {
    const w = locale.designReading
    const cascade = relation('lines', ['order_id'], 'orders', { onDelete: 'CASCADE' })
    const restrict = relation('orders', ['user_id'], 'users', { onDelete: 'RESTRICT' })
    const tree = relation('orders', ['parent_id'], 'orders', { onDelete: 'CASCADE' })
    const scenes = tourScenes({ name: 'shop', map: shop(), relations: [restrict, cascade, tree] })
    const hub = scenes.find((s) => s.title === t.hubTitle('orders', 1))
    expect(hub?.notes).toEqual([w.parts([w.pair('lines', 'orders')])])
    expect(scenes.at(-1)?.notes).toEqual([w.parts([w.pair('lines', 'orders')]), w.guarded([w.pair('orders', 'users')])])
  })

  describe('with the rows', () => {
    const w = locale.designReading
    const rows = new Map([
      ['users', 100],
      ['orders', 2000],
      ['lines', 50000],
      ['logs', 2000],
    ])

    it('tells the three tables with the most rows, the most first, as a chapter between the way and the checks', () => {
      const hops = joinPaths(relations, 'users', 'lines').paths[0] ?? []
      const map: DatabaseMap = { ...shop(), noPrimaryKey: ['logs'] }
      const scenes = tourScenes({ name: 'x', map, relations, path: { from: 'users', to: 'lines', hops }, rows })
      const titles = scenes.map((s) => s.title)
      const at = titles.indexOf(t.largestTitle(3))
      expect(titles[at - 1]).toBe(t.pathTitle('users', 'lines'))
      expect(titles[at + 1]).toBe(t.noPrimaryKeyTitle(1))
      expect(chaptersOf(scenes).map((c) => c.title)).toEqual([
        t.chapters.roles,
        t.chapters.hubs,
        t.chapters.path,
        t.chapters.largest,
        t.chapters.checks,
      ])
      const large = scenes[at]
      // orders and logs have as many: by name.
      expect(large?.text).toBe(`${t.largestText}${g.stop}${g.names(['lines', 'logs', 'orders'], -3)}`)
      expect(large?.frame).toEqual(['lines', 'logs', 'orders'])
      expect(large?.overlay.tables.get('lines')).toEqual({ tone: 'focus', badge: t.rowsBadge(50000) })
      expect(large?.notes).toEqual([w.rows('lines', 50000), w.rows('logs', 2000), w.rows('orders', 2000)])
      // What costs more for their size: logs has no primary key.
      expect(large?.hints).toEqual([w.noPrimaryKey('logs')])
    })

    it("hints at a large table's key with no index, where the key is drawn", () => {
      const map: DatabaseMap = {
        ...empty(),
        unindexedKeys: [
          { table: 'lines', key: toOrders.name, columns: ['order_id'], refTable: 'orders' },
          { table: 'orders', key: 'fk_elsewhere', columns: ['x_id'], refTable: 'other' },
        ],
      }
      const large = tourScenes({ name: 'x', map, relations, rows }).find((s) => s.title === t.largestTitle(3))
      expect(large?.hints).toEqual([w.unindexed('lines', 'order_id', 'orders')])
    })

    it('says nothing of rows where no table has an estimate', () => {
      const without = tourScenes({ name: 'x', map: shop(), relations })
      const empties = tourScenes({ name: 'x', map: shop(), relations, rows: new Map() })
      expect(empties).toEqual(without)
      expect(without.some((s) => s.chapter === t.chapters.largest)).toBe(false)
    })

    it('says the rows of a hub, and of each table that refers to it per row of it', () => {
      const hub = tourScenes({ name: 'x', map: shop(), relations, rows }).find(
        (s) => s.title === t.hubTitle('orders', 1)
      )
      // After what the design says of the keys into it.
      expect(hub?.notes?.slice(-2)).toEqual([w.rows('orders', 2000), w.perRow('orders', 'lines', 25)])
      expect(hub?.notes).toHaveLength(3)
    })

    it('says at each step of the way how many rows of the table that refers there are per row of the other', () => {
      const hops = joinPaths(relations, 'users', 'lines').paths[0] ?? []
      const walk = tourScenes({
        name: 'x',
        map: empty(),
        relations,
        path: { from: 'users', to: 'lines', hops },
        rows,
      }).filter((s) => s.title === t.pathTitle('users', 'lines'))
      expect(walk.map((s) => s.notes)).toEqual([[w.perRow('users', 'orders', 20)], [w.perRow('orders', 'lines', 25)]])
    })

    it('says a ratio once where two keys join the same two tables', () => {
      const twice = [...relations, relation('orders', ['payer_id'], 'users', { name: 'fk_payer' })]
      const map: DatabaseMap = { ...shop(), hubs: [{ table: 'users', referredBy: 1 }] }
      const hub = tourScenes({ name: 'x', map, relations: twice, rows }).find((s) => s.title === t.hubTitle('users', 1))
      expect(hub?.notes?.filter((n) => n === w.perRow('users', 'orders', 20))).toHaveLength(1)
      const hops = joinPaths(twice, 'users', 'orders').paths[0] ?? []
      // One step, along either key.
      expect(hops[0]?.keys).toHaveLength(2)
      const step = tourScenes({
        name: 'x',
        map: empty(),
        relations: twice,
        path: { from: 'users', to: 'orders', hops },
        rows,
      }).find((s) => s.title === t.pathTitle('users', 'orders'))
      expect(step?.notes).toEqual([w.perRow('users', 'orders', 20)])
    })

    it('says the rows a key with no index makes read in full, the most first', () => {
      const map: DatabaseMap = {
        ...empty(),
        unindexedKeys: [
          { table: 'orders', key: toUsers.name, columns: ['user_id'], refTable: 'users' },
          { table: 'lines', key: toOrders.name, columns: ['order_id'], refTable: 'orders' },
        ],
      }
      const check = tourScenes({ name: 'x', map, relations, rows }).find((s) => s.title === t.unindexedTitle(2))
      expect(check?.notes).toEqual([w.rows('lines', 50000), w.rows('orders', 2000)])
    })
  })
})
