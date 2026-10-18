import { describe, expect, it } from 'vitest'
import { neighbourhood } from './neighbourhood.ts'

// orders → users, items → orders, items → products, logs alone; reviews → products.
const keys = [
  { table: 'orders', refTable: 'users' },
  { table: 'items', refTable: 'orders' },
  { table: 'items', refTable: 'products' },
  { table: 'reviews', refTable: 'products' },
]
const all = ['users', 'orders', 'items', 'products', 'reviews', 'logs']
const around = (start: string, hops: number, tables = all) => [...neighbourhood(tables, keys, start, hops)].sort()

describe('neighbourhood', () => {
  it('reaches the tables one key away both ways, and the start', () => {
    expect(around('orders', 1)).toEqual(['items', 'orders', 'users'])
  })

  it('reaches further with more steps, each table once', () => {
    expect(around('orders', 2)).toEqual(['items', 'orders', 'products', 'users'])
    expect(around('orders', 3)).toEqual(['items', 'orders', 'products', 'reviews', 'users'])
  })

  it('gives the table alone when no key touches it, and nothing for a table not drawn', () => {
    expect(around('logs', 3)).toEqual(['logs'])
    expect(around('nowhere', 1)).toEqual([])
  })

  it('does not go through a table that is not drawn', () => {
    expect(around('users', 3, ['users', 'orders', 'products'])).toEqual(['orders', 'users'])
  })

  it('reaches only the start with no steps', () => {
    expect(around('orders', 0)).toEqual(['orders'])
  })
})
