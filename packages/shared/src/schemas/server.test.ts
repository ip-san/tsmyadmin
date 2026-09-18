import { describe, expect, it } from 'vitest'
import { replicationRole } from './server.ts'

describe('replicationRole', () => {
  it('tells the role from what the parts show', () => {
    expect(replicationRole([], [])).toBe('standalone')
    expect(replicationRole([{}], [])).toBe('replica')
    expect(replicationRole([], [{}])).toBe('primary')
    expect(replicationRole([{}], [{}])).toBe('relay')
  })

  it('does not guess "standalone" from parts it could not read', () => {
    // An account without the privilege sees nothing: that is not the same as there being nothing.
    expect(replicationRole(null, null)).toBe('unknown')
    expect(replicationRole(null, [])).toBe('unknown')
    expect(replicationRole([], null)).toBe('unknown')
    // What is known still counts: a replica stays one even where its own replicas cannot be listed.
    expect(replicationRole([{}], null)).toBe('replica')
    expect(replicationRole(null, [{}])).toBe('primary')
  })
})
