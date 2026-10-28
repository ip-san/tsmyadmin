import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { perRowReading, rowEstimates, rowsReading } from './row-estimates.ts'

const w = locale.designReading

describe('rowEstimates', () => {
  it('keeps the estimates worth saying: not an unknown one, nor a 0 that may be a partitioned parent', () => {
    const rows = rowEstimates([
      { name: 'orders', rowEstimate: 500 },
      { name: 'unknown', rowEstimate: null },
      { name: 'parent', rowEstimate: 0 },
    ])
    expect([...rows]).toEqual([['orders', 500]])
  })
})

describe('rowsReading', () => {
  it('says the rows of a table by the estimate, and nothing where there is none', () => {
    const rows = new Map([['orders', 1200]])
    expect(rowsReading(rows, 'orders')).toEqual([w.rows('orders', 1200)])
    expect(rowsReading(rows, 'users')).toEqual([])
    expect(rowsReading(undefined, 'orders')).toEqual([])
    expect(rowsReading(rows, 'orders', (x) => `${x}!`)).toEqual([w.rows('orders!', 1200)])
  })
})

describe('perRowReading', () => {
  const rows = new Map([
    ['users', 100],
    ['orders', 512],
    ['items', 6000],
    ['profiles', 40],
  ])

  it('says the rows that refer per row referred to: a decimal below 10, whole above', () => {
    expect(perRowReading(rows, 'orders', 'users')).toEqual([w.perRow('users', 'orders', 5.1)])
    expect(perRowReading(rows, 'items', 'orders')).toEqual([w.perRow('orders', 'items', 12)])
  })

  it('says how many rows referred to have none, where half the rows or fewer refer, and not for a nearer count', () => {
    expect(perRowReading(rows, 'profiles', 'users')).toEqual([
      w.perRow('users', 'profiles', 0.4),
      w.without('users', 'profiles', 60),
    ])
    // Two estimates 5% apart may be either way round: nothing is said of the rows without.
    const near = new Map([
      ['users', 100],
      ['profiles', 95],
      ['halves', 50],
    ])
    expect(perRowReading(near, 'profiles', 'users')).toEqual([w.perRow('users', 'profiles', 1)])
    expect(perRowReading(near, 'halves', 'users')).toEqual([
      w.perRow('users', 'halves', 0.5),
      w.without('users', 'halves', 50),
    ])
  })

  it('says a ratio under 0.1 as such, not as 0', () => {
    const few = new Map([
      ['users', 1000],
      ['admins', 3],
    ])
    expect(perRowReading(few, 'admins', 'users')).toEqual([
      w.perRowFew('users', 'admins'),
      w.without('users', 'admins', 997),
    ])
  })

  it('names the tables as asked, and says nothing of a key to itself or of a table not estimated', () => {
    expect(perRowReading(rows, 'orders', 'users', (x) => `${x}!`)).toEqual([w.perRow('users!', 'orders!', 5.1)])
    expect(perRowReading(rows, 'users', 'users')).toEqual([])
    expect(perRowReading(rows, 'orders', 'shops')).toEqual([])
    expect(perRowReading(undefined, 'orders', 'users')).toEqual([])
  })

  it('says the rows counted as counted, and how many have none for any difference, not only past half', () => {
    const counted = new Map<string, number | { counted: number }>([
      ['users', { counted: 100 }],
      ['profiles', { counted: 95 }],
      ['empty', { counted: 0 }],
      ['guessed', 50],
    ])
    expect(rowsReading(counted, 'users')).toEqual([w.rowsCounted('users', 100)])
    // A count of none is said: it is exact, unlike an estimate of 0.
    expect(rowsReading(counted, 'empty')).toEqual([w.rowsCounted('empty', 0)])
    expect(perRowReading(counted, 'profiles', 'users')).toEqual([
      w.perRowCounted('users', 'profiles', 1),
      w.withoutCounted('users', 'profiles', 5),
    ])
    // None counted: no average, only that no row referred to has one.
    expect(perRowReading(counted, 'empty', 'users')).toEqual([w.withoutCounted('users', 'empty', 100)])
    const few = new Map([
      ['users', { counted: 1000 }],
      ['admins', { counted: 3 }],
    ])
    expect(perRowReading(few, 'admins', 'users')).toEqual([
      w.perRowFewCounted('users', 'admins'),
      w.withoutCounted('users', 'admins', 997),
    ])
    // No rows referred to: no ratio.
    expect(perRowReading(counted, 'users', 'empty')).toEqual([])
    // One counted, one estimated: told as estimated, with the estimate's margin.
    expect(perRowReading(counted, 'guessed', 'users')).toEqual([
      w.perRow('users', 'guessed', 0.5),
      w.without('users', 'guessed', 50),
    ])
    expect(perRowReading(counted, 'profiles', 'guessed')).toEqual([w.perRow('guessed', 'profiles', 1.9)])
  })
})
