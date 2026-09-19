import { describe, expect, it } from 'vitest'
import { statsRows } from './StatsCard.tsx'

const none = {
  dataBytes: null,
  indexBytes: null,
  freeBytes: null,
  toastBytes: null,
  totalBytes: null,
  rowEstimate: null,
  avgRowBytes: null,
  rowFormat: null,
  createdAt: null,
  updatedAt: null,
  checkedAt: null,
  deadRows: null,
  lastVacuum: null,
  lastAnalyze: null,
}

describe('statsRows', () => {
  it('shows only the figures the server keeps', () => {
    const r = statsRows({ ...none, dataBytes: 16384, rowEstimate: 1234, rowFormat: 'Dynamic' })
    expect(r.space).toEqual([['データ', '16 KB']])
    expect(r.rows).toEqual([
      ['行数（概算）', '1,234'],
      ['行フォーマット', 'Dynamic'],
    ])
    expect(statsRows(none)).toEqual({ space: [], rows: [] })
  })
})
