import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { concurrently, widen } from '../test/concurrency-harness.ts'
import { SNAPSHOT_MAX_COUNT, SnapshotError, SnapshotStore, takeSnapshot } from './snapshots.ts'

const NS = { database: 'shop' }

/** A database of one small table, whose reads take a turn of the event loop like a real server's. */
function slowAdapter() {
  const adapter = new FakeAdapter({
    databases: { shop: { tables: { notes: fakeTable('notes', ['id', 'body'], [{ id: 1, body: 'hello' }]) } } },
  })
  widen(adapter, ['listTables', 'showCreateTable'])
  return adapter
}

/** What one snapshot of that database weighs, taken alone. */
async function oneSnapshotBytes(): Promise<number> {
  const store = new SnapshotStore({ sweepIntervalMs: 0 })
  return (await takeSnapshot(store, 'probe', slowAdapter(), NS, 'probe')).bytes
}

const reasons = (results: PromiseSettledResult<unknown>[]) =>
  results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as SnapshotError).reason] : []))

describe('snapshots taken at once', () => {
  it('keeps no more of one database than its count allows', async () => {
    // Each may weigh twice the real dump, so the total is never what turns one away here: the count is.
    const most = (await oneSnapshotBytes()) * 2
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const adapter = slowAdapter()
    const n = SNAPSHOT_MAX_COUNT + 6
    const results = await concurrently(n, (i) => takeSnapshot(store, 'one', adapter, NS, `s${i}`, new Date(), most))
    expect(store.list('one')).toHaveLength(SNAPSHOT_MAX_COUNT)
    expect(reasons(results)).toEqual(Array(n - SNAPSHOT_MAX_COUNT).fill('TOO_MANY'))
  })

  it('never holds more than the total, counting the ones still being read, and gives back every reservation', async () => {
    const bytes = await oneSnapshotBytes()
    // Room for three whole snapshots (and a little): twelve databases ask at once.
    const totalLimit = bytes * 3 + Math.floor(bytes / 2)
    const store = new SnapshotStore({ totalLimit, sweepIntervalMs: 0 })
    const adapter = slowAdapter()
    const scopes = Array.from({ length: 12 }, (_, i) => `db${i}`)
    const results = await concurrently(scopes.length, (i) =>
      takeSnapshot(store, scopes[i] ?? '', adapter, NS, 'before', new Date(), bytes * 2)
    )
    const held = scopes.flatMap((s) => store.list(s))
    const heldBytes = held.reduce((sum, s) => sum + s.bytes, 0)
    expect(heldBytes).toBeLessThanOrEqual(totalLimit)
    expect(held.length).toBeGreaterThan(0)
    expect(held.length + reasons(results).length).toBe(scopes.length)
    expect(new Set(reasons(results))).toEqual(new Set(['FULL']))
    // Nothing is still set aside once they are all done: the room left is exactly what is not held.
    expect(store.reserve(totalLimit).limit).toBe(totalLimit - heldBytes)
  })
})
