import type { Dialect, KeyValue } from '@tsmyadmin/shared'

/** How long the monitor keeps: samples beyond this are dropped from the front. */
const MAX_SAMPLES = 120
export const MONITOR_SECONDS = [1, 2, 5, 10, 30] as const

export interface Sample {
  /** Milliseconds since the epoch. */
  at: number
  values: ReadonlyMap<string, number>
}

export const toSample = (items: readonly KeyValue[], at: number): Sample => ({
  at,
  values: new Map(
    items.flatMap((i) =>
      i.value.trim() !== '' && Number.isFinite(Number(i.value)) ? [[i.name, Number(i.value)] as const] : []
    )
  ),
})

/** Adds a sample and drops the oldest past the limit. A sample at the same instant as the last replaces nothing. */
export function pushSample(samples: readonly Sample[], next: Sample, max = MAX_SAMPLES): Sample[] {
  const last = samples.at(-1)
  if (last && next.at <= last.at) return [...samples]
  return [...samples, next].slice(-max)
}

/** A line of a chart: a counter shown as a rate, or a current value as it is. */
export interface SeriesDef {
  key: string
  /** Status variables added together to make the figure. */
  variables: readonly string[]
  kind: 'rate' | 'gauge'
}

export interface ChartDef {
  id: string
  unit: 'perSecond' | 'count' | 'bytesPerSecond'
  series: readonly SeriesDef[]
}

export const CHARTS: Record<Dialect, readonly ChartDef[]> = {
  mysql: [
    { id: 'queries', unit: 'perSecond', series: [{ key: 'questions', variables: ['Questions'], kind: 'rate' }] },
    {
      id: 'connections',
      unit: 'count',
      series: [
        { key: 'connected', variables: ['Threads_connected'], kind: 'gauge' },
        { key: 'running', variables: ['Threads_running'], kind: 'gauge' },
      ],
    },
    {
      id: 'traffic',
      unit: 'bytesPerSecond',
      series: [
        { key: 'received', variables: ['Bytes_received'], kind: 'rate' },
        { key: 'sent', variables: ['Bytes_sent'], kind: 'rate' },
      ],
    },
  ],
  postgres: [
    {
      id: 'transactions',
      unit: 'perSecond',
      series: [
        { key: 'commits', variables: ['xact_commit'], kind: 'rate' },
        { key: 'rollbacks', variables: ['xact_rollback'], kind: 'rate' },
      ],
    },
    {
      id: 'rows',
      unit: 'perSecond',
      series: [
        { key: 'returned', variables: ['tup_returned'], kind: 'rate' },
        { key: 'inserted', variables: ['tup_inserted'], kind: 'rate' },
        { key: 'updated', variables: ['tup_updated'], kind: 'rate' },
        { key: 'deleted', variables: ['tup_deleted'], kind: 'rate' },
      ],
    },
    {
      id: 'connections',
      unit: 'count',
      series: [
        { key: 'total', variables: ['total_connections'], kind: 'gauge' },
        { key: 'active', variables: ['active_connections'], kind: 'gauge' },
      ],
    },
  ],
}

const sum = (s: Sample, names: readonly string[]): number | null => {
  let total = 0
  for (const name of names) {
    const v = s.values.get(name)
    if (v === undefined) return null
    total += v
  }
  return total
}

/**
 * One value per sample: a gauge as it is, a rate as the change since the sample before it over the seconds between
 * them. The first sample has no rate, and neither does one after a counter went backwards (a server restart).
 */
export function seriesValues(def: SeriesDef, samples: readonly Sample[]): (number | null)[] {
  return samples.map((s, i) => {
    const now = sum(s, def.variables)
    if (def.kind === 'gauge') return now
    const before = samples[i - 1]
    if (!before || now === null) return null
    const then = sum(before, def.variables)
    const seconds = (s.at - before.at) / 1000
    if (then === null || now < then || seconds <= 0) return null
    return (now - then) / seconds
  })
}
