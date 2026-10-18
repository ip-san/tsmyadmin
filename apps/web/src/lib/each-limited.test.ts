import { describe, expect, it } from 'vitest'
import { eachLimited } from './each-limited.ts'

describe('eachLimited', () => {
  it('gives what each item came to in their order, failures beside the rest', async () => {
    const done = await eachLimited([3, 1, 2], async (n) => {
      await new Promise((r) => setTimeout(r, n))
      if (n === 1) throw new Error('one')
      return n * 10
    })
    expect(done.map(({ item, settled }) => [item, settled.ok ? settled.value : 'failed'])).toEqual([
      [3, 30],
      [1, 'failed'],
      [2, 20],
    ])
  })

  it('runs no more than the limit at once', async () => {
    let running = 0
    let most = 0
    await eachLimited(
      Array.from({ length: 9 }, (_, i) => i),
      async () => {
        running += 1
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, 1))
        running -= 1
      },
      { limit: 2 }
    )
    expect(most).toBe(2)
  })

  it('starts nothing more once aborted, leaving those out', async () => {
    const stop = new AbortController()
    const done = await eachLimited(
      ['a', 'b', 'c'],
      async (x) => {
        stop.abort()
        return x
      },
      { limit: 1, signal: stop.signal }
    )
    expect(done.map((d) => d.item)).toEqual(['a'])
  })
})
