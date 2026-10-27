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

  it('says how many rows referred to have none at least, where fewer rows refer', () => {
    expect(perRowReading(rows, 'profiles', 'users')).toEqual([
      w.perRow('users', 'profiles', 0.4),
      w.without('users', 'profiles', 60),
    ])
  })

  it('names the tables as asked, and says nothing of a key to itself or of a table not estimated', () => {
    expect(perRowReading(rows, 'orders', 'users', (x) => `${x}!`)).toEqual([w.perRow('users!', 'orders!', 5.1)])
    expect(perRowReading(rows, 'users', 'users')).toEqual([])
    expect(perRowReading(rows, 'orders', 'shops')).toEqual([])
    expect(perRowReading(undefined, 'orders', 'users')).toEqual([])
  })
})
