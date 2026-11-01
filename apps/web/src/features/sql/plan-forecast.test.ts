import type { ExplainResult, PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { forecastOf, forecastVerdict } from './plan-forecast.ts'

const plan = (cost: number | null): PlanNode => ({
  op: 'Seq Scan',
  table: 'logs',
  alias: null,
  index: null,
  indexColumns: [],
  access: 'fullScan',
  covering: false,
  estRows: 10,
  cost,
  detail: null,
  children: [],
})
const result = (cost: number | null, assumed?: string[]): ExplainResult => ({
  plan: plan(cost),
  raw: '',
  rawTruncated: false,
  ...(assumed ? { assumed } : {}),
})

describe('forecastOf', () => {
  it('keeps the two costs, and whether the plan read through the index asked for', () => {
    expect(forecastOf(result(1693), result(8.3, ['idx_logs_level']), 'idx_logs_level')).toEqual({
      costBefore: 1693,
      costAfter: 8.3,
      used: true,
    })
    expect(forecastOf(result(1693), result(1693, []), 'idx_logs_level').used).toBe(false)
    expect(forecastOf(result(null), result(null), 'idx_logs_level')).toEqual({
      costBefore: null,
      costAfter: null,
      used: false,
    })
  })
})

describe('forecastVerdict', () => {
  const said = (used: boolean) => ({ costBefore: 10, costAfter: 1, used })
  it('says whether the run bore the forecast out', () => {
    expect(forecastVerdict(said(true), true)).toBe('used')
    expect(forecastVerdict(said(true), false)).toBe('notUsed')
    expect(forecastVerdict(said(false), false)).toBe('unused')
    expect(forecastVerdict(said(false), true)).toBe('usedAnyway')
  })
})
