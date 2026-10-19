import { describe, expect, it } from 'vitest'
import { relation } from '@/test/schema-fixtures.ts'
import { joinPaths } from './join-path.ts'

/** The tables of each path, joined by arrows. */
const routes = (paths: ReturnType<typeof joinPaths>['paths']) =>
  paths.map((p) => [p[0]?.from, ...p.map((h) => h.to)].join('>'))

// orders → users, orders → products, reviews → users, reviews → products, products → makers
const shop = [
  relation('orders', ['user_id'], 'users'),
  relation('orders', ['product_id'], 'products'),
  relation('reviews', ['user_id'], 'users'),
  relation('reviews', ['product_id'], 'products'),
  relation('products', ['maker_id'], 'makers'),
]

describe('joinPaths', () => {
  it('follows a key forwards, then one backwards, and tells which way each goes', () => {
    const { paths, more } = joinPaths(shop, 'orders', 'makers')
    expect(routes(paths)).toEqual(['orders>products>makers'])
    expect(more).toBe(false)
    expect(paths[0]?.map((h) => h.keys.map((k) => [k.relation.table, k.relation.name, k.forward]))).toEqual([
      [['orders', 'fk_products', true]],
      [['products', 'fk_makers', true]],
    ])
    const back = joinPaths(shop, 'makers', 'orders').paths[0]
    expect(back?.map((h) => [h.from, h.to, h.keys[0]?.forward])).toEqual([
      ['makers', 'products', false],
      ['products', 'orders', false],
    ])
  })

  it('gives every shortest path, in the order of the names, and only the shortest', () => {
    // users to products: through orders or through reviews (two steps each); not through makers.
    expect(routes(joinPaths(shop, 'users', 'products').paths)).toEqual([
      'users>orders>products',
      'users>reviews>products',
    ])
    // A direct key is the only shortest path, though longer ones exist.
    expect(routes(joinPaths(shop, 'orders', 'users').paths)).toEqual(['orders>users'])
  })

  it('orders the paths by the names of their tables, not by the order the keys are listed in', () => {
    const listed = [...shop].reverse()
    expect(routes(joinPaths(listed, 'users', 'products').paths)).toEqual([
      'users>orders>products',
      'users>reviews>products',
    ])
    // By code unit, the same in every browser: an upper-case name before a lower-case one.
    const cased = [
      relation('b', ['x_id'], 'x'),
      relation('B', ['x_id'], 'x'),
      relation('b', ['y_id'], 'y'),
      relation('B', ['y_id'], 'y'),
    ]
    expect(routes(joinPaths(cased, 'x', 'y').paths)).toEqual(['x>B>y', 'x>b>y'])
  })

  it('stops looking once it has found more than the limit, however many paths there are', () => {
    // 30 rows of two tables, each joined to both of the next: 2^30 shortest paths, never all walked.
    const row = (i: number) => [`a${i}`, `b${i}`]
    const ladder = Array.from({ length: 30 }, (_, i) =>
      row(i).flatMap((t) => row(i + 1).map((n) => relation(t, [`${n}_id`], n, { name: `fk_${t}_${n}` })))
    ).flat()
    const { paths, more } = joinPaths(ladder, 'a0', 'a30')
    expect(paths).toHaveLength(3)
    expect(more).toBe(true)
  }, 2000)

  it('stops at the limit, and tells there are more', () => {
    const many = ['a', 'b', 'c', 'd'].flatMap((m) => [relation(m, ['x_id'], 'x'), relation(m, ['y_id'], 'y')])
    const three = joinPaths(many, 'x', 'y')
    expect(routes(three.paths)).toEqual(['x>a>y', 'x>b>y', 'x>c>y'])
    expect(three.more).toBe(true)
    const four = joinPaths(many, 'x', 'y', 4)
    expect(four.paths).toHaveLength(4)
    expect(four.more).toBe(false)
    expect(joinPaths(many, 'x', 'y', 1)).toMatchObject({ more: true, paths: [expect.anything()] })
  })

  it('lists every key between a pair in one step, by name', () => {
    const two = [
      relation('posts', ['updated_by'], 'users', { name: 'fk_updated' }),
      relation('posts', ['created_by'], 'users', { name: 'fk_created' }),
      relation('users', ['pinned_post'], 'posts', { name: 'fk_pinned' }),
    ]
    const { paths } = joinPaths(two, 'posts', 'users')
    expect(paths).toHaveLength(1)
    expect(paths[0]?.[0]?.keys.map((k) => [k.relation.name, k.forward])).toEqual([
      ['fk_created', true],
      ['fk_pinned', false],
      ['fk_updated', true],
    ])
  })

  it('finds nothing between tables no key links, or from a table to itself', () => {
    expect(joinPaths(shop, 'orders', 'logs')).toEqual({ paths: [], more: false })
    expect(joinPaths(shop, 'logs', 'orders')).toEqual({ paths: [], more: false })
    expect(joinPaths(shop, 'orders', 'orders')).toEqual({ paths: [], more: false })
    expect(joinPaths([], 'a', 'b')).toEqual({ paths: [], more: false })
  })

  it('does not step along a key from a table to itself', () => {
    const tree = [relation('categories', ['parent_id'], 'categories'), relation('items', ['category_id'], 'categories')]
    const { paths } = joinPaths(tree, 'items', 'categories')
    expect(paths[0]?.[0]?.keys.map((k) => k.relation.columns)).toEqual([['category_id']])
    expect(joinPaths([relation('categories', ['parent_id'], 'categories')], 'categories', 'items').paths).toEqual([])
  })

  it('walks a long chain, step by step', () => {
    const chain = ['b', 'c', 'd', 'e'].map((t, i) => relation(['a', 'b', 'c', 'd'][i] ?? '', [`${t}_id`], t))
    expect(routes(joinPaths(chain, 'a', 'e').paths)).toEqual(['a>b>c>d>e'])
    expect(routes(joinPaths(chain, 'e', 'b').paths)).toEqual(['e>d>c>b'])
  })
})
