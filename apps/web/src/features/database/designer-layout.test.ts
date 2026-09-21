import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import {
  autoLayout,
  boxColumns,
  boxHeight,
  drawnRelations,
  fitText,
  GRID,
  HEADER_HEIGHT,
  relationLabel,
  relationPath,
  relationRoute,
  routeMiddle,
  snapToGrid,
  textRoom,
  withAllColumns,
} from './designer-layout.ts'

const rel = (table: string, refTable: string, extra: Partial<RelationDef> = {}): RelationDef => ({
  table,
  name: `fk_${table}_${refTable}`,
  columns: [`${refTable}_id`],
  refNamespace: { database: 'app' },
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
  ...extra,
})

describe('designer layout', () => {
  it('places a table one column right of the furthest table it references', () => {
    const relations = [rel('posts', 'users'), rel('comments', 'posts'), rel('comments', 'users')]
    const at = autoLayout(['comments', 'posts', 'users', 'tags'], relations)
    expect(at.users?.x).toBe(at.tags?.x)
    expect(at.posts?.x).toBeGreaterThan(at.users?.x ?? 0)
    expect(at.comments?.x).toBeGreaterThan(at.posts?.x ?? 0)
    // Two tables in one column do not overlap.
    expect(at.tags?.y).toBeGreaterThan(at.users?.y ?? 0)
  })

  it('terminates on a cycle and on a key to the table itself', () => {
    const relations = [rel('a', 'b'), rel('b', 'a'), rel('a', 'a')]
    const at = autoLayout(['a', 'b'], relations)
    expect(Object.keys(at)).toEqual(['a', 'b'])
  })

  it('lists key columns first, then referenced ones, once each', () => {
    const relations = [rel('posts', 'users'), rel('comments', 'posts', { columns: ['post_id'] })]
    expect(boxColumns('posts', relations)).toEqual(['users_id', 'id'])
  })

  it('draws only keys between tables on the diagram, in the same schema', () => {
    const ns = { database: 'app', schema: 'public' }
    const relations = [
      rel('posts', 'users', { refNamespace: { database: 'app', schema: 'public' } }),
      rel('posts', 'users', { name: 'elsewhere', refNamespace: { database: 'app', schema: 'audit' } }),
      rel('posts', 'missing', { refNamespace: { database: 'app', schema: 'public' } }),
    ]
    expect(drawnRelations(relations, 'postgres', ns, ['posts', 'users']).map((r) => r.name)).toEqual(['fk_posts_users'])
    // No schema in the URL is public, not "any schema".
    expect(drawnRelations(relations, 'postgres', { database: 'app' }, ['posts', 'users']).map((r) => r.name)).toEqual([
      'fk_posts_users',
    ])
    expect(drawnRelations([rel('posts', 'users')], 'mysql', { database: 'app' }, ['posts', 'users'])).toHaveLength(1)
    const elsewhere = rel('posts', 'users', { refNamespace: { database: 'other' } })
    expect(drawnRelations([elsewhere], 'mysql', { database: 'app' }, ['posts', 'users'])).toHaveLength(0)
  })

  it('lists the key columns first, then the rest once, when every column is shown', () => {
    expect(withAllColumns(['user_id'], ['id', 'user_id', 'title'])).toEqual(['user_id', 'id', 'title'])
    expect(withAllColumns(['user_id'], undefined)).toEqual(['user_id'])
  })

  it('draws a key from its column row to the referenced column row', () => {
    const at = (t: string) => (t === 'posts' ? { x: 300, y: 0 } : { x: 0, y: 0 })
    const columns = (t: string) => (t === 'posts' ? ['id', 'user_id'] : ['id'])
    // posts.user_id is the second row of its box; users.id the first, and the users box is on the left.
    expect(relationPath(rel('posts', 'users', { columns: ['user_id'] }), at, columns)).toMatch(/^M 300 58 C .* 200 38$/)
  })
})

describe('relationRoute and friends', () => {
  const key: RelationDef = {
    table: 'posts',
    name: 'fk',
    columns: ['user_id'],
    refNamespace: { database: 'app' },
    refTable: 'users',
    refColumns: ['id'],
    onUpdate: null,
    onDelete: null,
  }
  const at = (t: string) => (t === 'posts' ? { x: 400, y: 0 } : { x: 0, y: 0 })
  const columnsOf = (t: string) => (t === 'posts' ? ['user_id'] : ['id'])

  it('draws the key as a curve, a straight line or right angles', () => {
    expect(relationRoute(key, at, columnsOf).kind).toBe('curve')
    expect(relationRoute(key, at, columnsOf, 'straight')).toMatchObject({
      kind: 'lines',
      points: [expect.anything(), expect.anything()],
    })
    const angles = relationRoute(key, at, columnsOf, 'polyline')
    expect(angles.kind === 'lines' && angles.points).toHaveLength(6)
    expect(relationPath(key, at, columnsOf, 'straight')).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/)
  })

  it('meets the header of a compact box, and puts the label at the middle of the line', () => {
    const route = relationRoute(key, at, columnsOf, 'straight', true)
    expect(route.kind === 'lines' && route.points.map((p) => p.y)).toEqual([HEADER_HEIGHT / 2, HEADER_HEIGHT / 2])
    expect(routeMiddle(route).y).toBe(HEADER_HEIGHT / 2)
    expect(relationLabel(key)).toBe('user_id → id')
    expect(boxHeight(5, true)).toBe(HEADER_HEIGHT)
  })

  it('snaps a point to the grid', () => {
    expect(snapToGrid({ x: 29, y: 31 })).toEqual({ x: 20, y: 40 })
    expect(GRID).toBe(20)
  })
})

describe('fitText', () => {
  const room = textRoom(8)

  it('leaves a name that fits as it is', () => {
    expect(fitText('users', 12, room)).toBe('users')
    expect(fitText('user_id', 12, room)).toBe('user_id')
    expect(fitText('', 12, room)).toBe('')
  })

  it('cuts a long name with an ellipsis so it stays inside the box', () => {
    const long = 'customer_billing_address_postal_code_verification_status'
    const cut = fitText(long, 12, room)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThan(long.length)
    expect(long.startsWith(cut.slice(0, -1))).toBe(true)
    // Cutting again changes nothing: it already fits.
    expect(fitText(cut, 12, room)).toBe(cut)
  })

  it('counts a Japanese name as one em a character, and bold as wider', () => {
    // Twelve full-width characters are 144 px at 12 px: past the 184 px of room only after a few more.
    expect(fitText('顧客請求先住所', 12, room)).toBe('顧客請求先住所')
    const long = '顧客請求先住所郵便番号確認状況区分コード'
    const cut = fitText(long, 12, room)
    expect(cut.endsWith('…')).toBe(true)
    expect(([...cut].length - 1) * 12).toBeLessThanOrEqual(room)
    const name = 'a_table_name_that_is_fairly_long'
    expect(fitText(name, 12, room, true).length).toBeLessThanOrEqual(fitText(name, 12, room).length)
  })

  it('always keeps something of a name that cannot fit at all', () => {
    expect(fitText('abcdef', 12, 1)).toBe('a…')
  })
})
