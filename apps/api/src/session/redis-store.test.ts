import { describe, expect, it } from 'vitest'
import { partitionByExistence } from './redis-store.ts'

describe('partitionByExistence', () => {
  it('only treats a session as gone when Redis actually said so', () => {
    const members = ['live', 'gone', 'errored', 'missing-reply']
    const replies: [Error | null, unknown][] = [
      [null, 1],
      [null, 0],
      // A failed command proves nothing. Reading it as "gone" would remove a live session's index member, which
      // then escapes both the cap and eviction until its TTL runs out.
      [new Error("READONLY You can't write against a read only replica"), undefined],
    ]
    expect(partitionByExistence(members, replies)).toEqual({
      held: ['live', 'errored', 'missing-reply'],
      stale: ['gone'],
    })
  })

  it('keeps every member when the pipeline itself returned nothing', () => {
    expect(partitionByExistence(['a', 'b'], null)).toEqual({ held: ['a', 'b'], stale: [] })
  })
})
