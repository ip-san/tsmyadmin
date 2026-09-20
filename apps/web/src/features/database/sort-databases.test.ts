import type { DatabaseInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { sortDatabases } from './sort-databases.ts'

const db = (name: string, sizeBytes: number | null, tableCount: number | null = null): DatabaseInfo => ({
  name,
  sizeBytes,
  tableCount,
  collation: null,
})

describe('sortDatabases', () => {
  const list = [db('b', 10), db('a', null), db('c', 500)]

  it('orders by size with the uncounted ones last in both directions', () => {
    expect(sortDatabases(list, 'sizeBytes', 'asc').map((d) => d.name)).toEqual(['b', 'c', 'a'])
    expect(sortDatabases(list, 'sizeBytes', 'desc').map((d) => d.name)).toEqual(['c', 'b', 'a'])
  })

  it('orders by name and by table count, without touching the list it was given', () => {
    expect(sortDatabases(list, 'name', 'desc').map((d) => d.name)).toEqual(['c', 'b', 'a'])
    expect(sortDatabases([db('x', 1, 9), db('y', 1, 2)], 'tableCount', 'asc').map((d) => d.name)).toEqual(['y', 'x'])
    expect(list.map((d) => d.name)).toEqual(['b', 'a', 'c'])
  })
})
