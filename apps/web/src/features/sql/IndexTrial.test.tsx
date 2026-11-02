import { cleanup, render, screen, within } from '@testing-library/react'
import type { ExplainResult, PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import type { DdlFlow } from '@/lib/ddl.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { IndexTrial } from './IndexTrial.tsx'
import type { Forecast } from './plan-forecast.ts'
import type { IndexTrial as Trial } from './use-index-trial.ts'

const p = locale.plan
const scan = (index: string | null, ms: number): PlanNode => ({
  op: index ? 'Index Scan' : 'Seq Scan',
  table: 'logs',
  alias: null,
  index,
  indexColumns: [],
  access: index ? 'lookup' : 'fullScan',
  covering: false,
  estRows: 50,
  cost: null,
  detail: '(level = 3)',
  children: [],
  actual: { rows: 12, loops: 1, ms },
})
const run = (index: string | null, ms: number): ExplainResult => ({
  plan: scan(index, ms),
  raw: '',
  rawTruncated: false,
  measured: { ms },
})
const flow: DdlFlow = {
  op: null,
  sql: [],
  previewing: false,
  running: false,
  error: null,
  failed: null,
  executed: null,
  notices: [],
  rolledBack: false,
  stopping: false,
  stopped: false,
  stopUnclear: false,
  stopError: null,
  preview: () => undefined,
  confirm: () => undefined,
  cancel: () => undefined,
}
const tried = { table: 'logs', columns: ['level'], name: 'idx_logs_level', reason: 'filter' as const }

/** The index tried, measured again with `after`, built from `forecast` (or not). */
function shown(after: ExplainResult, forecast: Forecast | null) {
  const trial: Trial = {
    flow,
    tried,
    forecast,
    after,
    measuring: false,
    stopping: false,
    stopped: false,
    error: null,
    start: () => undefined,
    measure: async () => undefined,
    stop: () => undefined,
    undo: () => undefined,
    online: true,
    setOnline: () => undefined,
    dropLeftover: () => undefined,
  }
  render(
    <IndexTrial
      trial={trial}
      build={{ forecasting: false, start: async () => undefined }}
      candidates={[]}
      before={run(null, 400)}
    />
  )
  return screen.getByRole('region', { name: p.trialGroup })
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
afterEach(cleanup)

describe('IndexTrial, beside the forecast', () => {
  it('says the run bore it out where the server used the index as forecast', () => {
    const trial = shown(run('idx_logs_level', 4), { costBefore: 1693, costAfter: 8.3, used: true })
    expect(trial.textContent).toContain(p.forecastSaid(1693, 8.3, true))
    expect(trial.textContent).toContain(p.forecastVerdict.used)
  })

  it('says so where the run did not bear the forecast out, either way', () => {
    expect(shown(run(null, 400), { costBefore: 1693, costAfter: 8.3, used: true }).textContent).toContain(
      p.forecastVerdict.notUsed
    )
    cleanup()
    expect(shown(run('idx_logs_level', 4), { costBefore: 10, costAfter: 10, used: false }).textContent).toContain(
      p.forecastVerdict.usedAnyway
    )
  })

  it('sets nothing beside an index tried without a forecast', () => {
    const trial = shown(run('idx_logs_level', 4), null)
    expect(trial.textContent).not.toContain(p.forecastUnits)
  })
})

describe('IndexTrial, while the forecast is asked before building', () => {
  it('says so, and building waits (the button stays, its name the same)', () => {
    const start = vi.fn(async () => undefined)
    const trial: Trial = {
      flow,
      tried: null,
      forecast: null,
      after: null,
      measuring: false,
      stopping: false,
      stopped: false,
      error: null,
      start: () => undefined,
      measure: async () => undefined,
      stop: () => undefined,
      undo: () => undefined,
      online: true,
      setOnline: () => undefined,
      dropLeftover: () => undefined,
    }
    render(
      <IndexTrial trial={trial} build={{ forecasting: true, start }} candidates={[tried]} before={run(null, 400)} />
    )
    const group = screen.getByRole('region', { name: p.trialGroup })
    expect(
      within(group)
        .getAllByRole('status')
        .map((s) => s.textContent)
    ).toContain(p.trialForecasting)
    const button = within(group).getByRole('button', { name: p.trialTry('logs', ['level']) })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    button.click()
    expect(start).not.toHaveBeenCalled()
  })
})
