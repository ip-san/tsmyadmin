import { describe, expect, it } from 'vitest'
import { pushSample, type Sample, type SeriesDef, seriesValues, toSample } from './monitor.ts'

const at = (ms: number, o: Record<string, number>): Sample => ({ at: ms, values: new Map(Object.entries(o)) })
const rate: SeriesDef = { key: 'q', variables: ['Questions'], kind: 'rate' }

describe('seriesValues', () => {
  it('turns a counter into a rate over the seconds between samples', () => {
    const samples = [at(0, { Questions: 100 }), at(2000, { Questions: 300 }), at(3000, { Questions: 350 })]
    expect(seriesValues(rate, samples)).toEqual([null, 100, 50])
  })

  it('has no rate across a counter that went backwards (a restart)', () => {
    const samples = [at(0, { Questions: 900 }), at(1000, { Questions: 5 }), at(2000, { Questions: 15 })]
    expect(seriesValues(rate, samples)).toEqual([null, null, 10])
  })

  it('adds variables together and passes a gauge through', () => {
    const both: SeriesDef = { key: 'x', variables: ['a', 'b'], kind: 'rate' }
    expect(seriesValues(both, [at(0, { a: 1, b: 1 }), at(1000, { a: 3, b: 5 })])).toEqual([null, 6])
    const gauge: SeriesDef = { key: 'g', variables: ['Threads_connected'], kind: 'gauge' }
    expect(seriesValues(gauge, [at(0, { Threads_connected: 4 }), at(1, {})])).toEqual([4, null])
  })
})

describe('pushSample', () => {
  it('keeps the newest and ignores a sample that is not newer', () => {
    let samples: Sample[] = []
    for (let i = 1; i <= 5; i++) samples = pushSample(samples, at(i, {}), 3)
    expect(samples.map((s) => s.at)).toEqual([3, 4, 5])
    expect(pushSample(samples, at(5, {}), 3).map((s) => s.at)).toEqual([3, 4, 5])
  })
})

describe('toSample', () => {
  it('keeps the numeric variables only', () => {
    const s = toSample(
      [
        { name: 'Questions', value: '12', description: null },
        { name: 'Version', value: '8.0.1-log', description: null },
        { name: 'Empty', value: '', description: null },
      ],
      7
    )
    expect([...s.values]).toEqual([['Questions', 12]])
  })
})
