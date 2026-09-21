import type { DiagnosticReport } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { clockTime, EMPTY_HISTORY, foldReport, RECENT_KEPT } from './recent-statements.ts'

const NOW = new Date('2026-09-21T01:02:03.456Z')
const log = (rows: string[][]): DiagnosticReport => ({ status: 'ok', columns: ['time', 'statement'], rows, text: null })
const counts = (rows: string[][]): DiagnosticReport => ({
  status: 'ok',
  columns: ['statement', 'runs'],
  rows,
  text: null,
})

describe('foldReport', () => {
  it('adds the general log rows as they come and remembers the newest time', () => {
    const one = foldReport(
      EMPTY_HISTORY,
      log([
        ['2026-09-21 10:00:02.000000', 'SELECT 2'],
        ['2026-09-21 10:00:01.000000', 'SELECT 1'],
      ]),
      NOW
    )
    expect(one.entries.map((e) => e.statement)).toEqual(['SELECT 2', 'SELECT 1'])
    expect(one.since).toBe('2026-09-21 10:00:02.000000')
    const two = foldReport(one, log([['2026-09-21 10:00:03.000000', 'SELECT 3']]), NOW)
    expect(two.entries.map((e) => e.statement)).toEqual(['SELECT 3', 'SELECT 2', 'SELECT 1'])
    expect(two.since).toBe('2026-09-21 10:00:03.000000')
    expect(new Set(two.entries.map((e) => e.id)).size).toBe(3)
  })

  it('keeps the time it had when a read finds nothing new', () => {
    const one = foldReport(EMPTY_HISTORY, log([['2026-09-21 10:00:02.000000', 'SELECT 2']]), NOW)
    expect(foldReport(one, log([]), NOW).since).toBe(one.since)
  })

  it('takes the first PostgreSQL read as the baseline, then adds what grew', () => {
    const base = foldReport(EMPTY_HISTORY, counts([['SELECT 1', '5']]), NOW)
    expect(base.entries).toEqual([])
    const next = foldReport(
      base,
      counts([
        ['SELECT 1', '8'],
        ['SELECT 2', '1'],
      ]),
      NOW
    )
    expect(next.entries.map((e) => [e.statement, e.runs])).toEqual([
      ['SELECT 1', 3],
      ['SELECT 2', 1],
    ])
    // The moment the page read it, on the reader's own clock: one time for what one read found.
    expect(next.entries[0]?.time).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.456$/)
    expect(next.entries[1]?.time).toBe(next.entries[0]?.time)
    expect(
      foldReport(
        next,
        counts([
          ['SELECT 1', '8'],
          ['SELECT 2', '1'],
        ]),
        NOW
      ).entries
    ).toHaveLength(2)
  })

  it('treats a count that fell (statistics reset) as a new baseline', () => {
    const base = foldReport(EMPTY_HISTORY, counts([['SELECT 1', '9']]), NOW)
    const reset = foldReport(base, counts([['SELECT 1', '2']]), NOW)
    expect(reset.entries).toEqual([])
    expect(foldReport(reset, counts([['SELECT 1', '3']]), NOW).entries[0]?.runs).toBe(1)
  })

  it('keeps only the newest entries and ignores a report that is not ok', () => {
    const rows = Array.from({ length: RECENT_KEPT + 5 }, (_, i) => [
      `2026-09-21 10:00:00.${String(i).padStart(6, '0')}`,
      `S${i}`,
    ])
    expect(foldReport(EMPTY_HISTORY, log(rows), NOW).entries).toHaveLength(RECENT_KEPT)
    const off: DiagnosticReport = { status: 'disabled', columns: [], rows: [], text: null }
    expect(foldReport(EMPTY_HISTORY, off, NOW)).toBe(EMPTY_HISTORY)
  })
})

describe('clockTime', () => {
  it('cuts the clock time out of a logged time', () => {
    expect(clockTime('2026-09-21 10:00:02.123456')).toBe('10:00:02.123')
  })
})
