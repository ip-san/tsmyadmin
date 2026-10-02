import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it, vi } from 'vitest'
import { SNAPSHOT_TTL_MS, SnapshotError, SnapshotStore, takeSnapshot } from './snapshots.ts'

const NS = { database: 'shop' }

/** A database whose one table holds `rows` rows of `text`. */
function adapter(text = 'hello', rows = 1) {
  return new FakeAdapter({
    databases: {
      shop: {
        tables: {
          notes: fakeTable(
            'notes',
            ['id', 'body'],
            Array.from({ length: rows }, (_, i) => ({ id: i + 1, body: text }))
          ),
        },
      },
    },
  })
}

const BIG = 10 * 1024 * 1024

/** The dump of that database in bytes and in characters, taken once with room to spare. */
async function sizes(a: FakeAdapter) {
  const store = new SnapshotStore()
  const taken = await takeSnapshot(store, 's', a, NS, 'probe', new Date(), BIG)
  const sql = store.get('s', taken.id)?.sql ?? ''
  return { bytes: taken.bytes, chars: sql.length }
}

async function refusal(run: Promise<unknown>): Promise<SnapshotError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(SnapshotError)
  return err as SnapshotError
}

describe('the room snapshots may fill', () => {
  it('sets aside the least of what a snapshot may take and what is left, and gives it back', () => {
    const store = new SnapshotStore({ totalLimit: 100 })
    const first = store.reserve(60)
    expect(first.limit).toBe(60)
    const second = store.reserve(60)
    expect(second.limit).toBe(40)
    expect(() => store.reserve(60)).toThrowError(/total limit/)
    first.release()
    expect(store.reserve(60).limit).toBe(60)
    // 60 is set aside again now. Giving back the second one's 40 twice must free them once: 40 are left, not 80.
    second.release()
    second.release()
    expect(store.reserve(100).limit).toBe(40)
  })

  it('counts what is held as well as what is being taken', async () => {
    const a = adapter()
    const { bytes } = await sizes(a)
    const store = new SnapshotStore({ totalLimit: bytes + 30 })
    await takeSnapshot(store, 's', a, NS, 'one', new Date(), BIG)
    expect(store.reserve(BIG).limit).toBe(30)
  })

  it('refuses the snapshot that would pass the total while others are being taken, and takes again once they end', async () => {
    const a = adapter()
    const { bytes } = await sizes(a)
    // Room for two dumps of this size, each allowed `bytes + 1`.
    const store = new SnapshotStore({ totalLimit: 2 * (bytes + 1) })
    const taking = [0, 1].map((i) => takeSnapshot(store, `s${i}`, a, NS, `n${i}`, new Date(), bytes + 1))
    const third = await refusal(takeSnapshot(store, 's2', a, NS, 'n2', new Date(), bytes + 1))
    expect(third.reason).toBe('FULL')
    await Promise.all(taking)
    // Both are held now, and still count: no room for a third until one is removed.
    expect((await refusal(takeSnapshot(store, 's2', a, NS, 'n2', new Date(), bytes + 1))).reason).toBe('FULL')
    expect(store.list('s0')).toHaveLength(1)
  })

  it('lets a small database in when the store is nearly full, and calls a dump that outgrows the room "full"', async () => {
    const small = adapter('a', 1)
    const large = adapter('b'.repeat(2000), 5)
    const smallSize = await sizes(small)
    const largeSize = await sizes(large)
    expect(largeSize.bytes).toBeGreaterThan(smallSize.bytes + 1000)
    const store = new SnapshotStore({ totalLimit: smallSize.bytes * 2 + 50 })
    await takeSnapshot(store, 'x', small, NS, 'one', new Date(), BIG)
    // Another small one fits in what is left, though the most a snapshot may take is far more than that.
    await takeSnapshot(store, 'y', small, NS, 'two', new Date(), BIG)
    expect(store.list('y')).toHaveLength(1)
    // A large one does not: refused for the room, not for being over the limit of one dump.
    expect((await refusal(takeSnapshot(store, 'z', large, NS, 'big', new Date(), BIG))).reason).toBe('FULL')
  })
})

describe('the size of one dump', () => {
  it('is counted in bytes: text in a wide script weighs more than its length', async () => {
    const a = adapter('あ'.repeat(20), 100)
    const { bytes, chars } = await sizes(a)
    expect(bytes).toBeGreaterThan(chars + 1000)
    // Longer than the limit in bytes, shorter in characters: a count of characters would let it through.
    const err = await refusal(takeSnapshot(new SnapshotStore(), 's', a, NS, 'wide', new Date(), chars + 100))
    expect(err.reason).toBe('TOO_LARGE')
    // And one that fits in bytes is taken.
    await takeSnapshot(new SnapshotStore(), 's', a, NS, 'wide', new Date(), bytes + 100)
  })
})

describe('how long a snapshot is kept', () => {
  const T0 = Date.UTC(2026, 0, 1)
  const HOUR = 60 * 60_000

  /** A clock the test moves by hand. */
  function clock() {
    let t = T0
    return {
      now: () => t,
      set: (v: number) => {
        t = v
      },
    }
  }

  it('keeps one until it is a day old, then lets it go and gives its room back', async () => {
    const a = adapter()
    const { bytes } = await sizes(a)
    const c = clock()
    const store = new SnapshotStore({ totalLimit: bytes + 10, now: c.now, sweepIntervalMs: 0 })
    const taken = await takeSnapshot(store, 's', a, NS, 'one', new Date(T0), BIG)

    c.set(T0 + SNAPSHOT_TTL_MS - 1)
    expect(store.list('s')).toHaveLength(1)
    const held = store.reserve(BIG)
    expect(held.limit).toBe(10)
    held.release()

    c.set(T0 + SNAPSHOT_TTL_MS + 1)
    expect(store.list('s')).toEqual([])
    expect(store.get('s', taken.id)).toBeUndefined()
    expect(store.reserve(BIG).limit).toBe(bytes + 10)
  })

  it('lets go of the old ones only, whoever took them, and says how many', async () => {
    const a = adapter()
    const c = clock()
    const onExpire = vi.fn()
    const store = new SnapshotStore({ now: c.now, sweepIntervalMs: 0, onExpire })
    await takeSnapshot(store, 'old-1', a, NS, 'a', new Date(T0), BIG)
    await takeSnapshot(store, 'old-2', a, NS, 'b', new Date(T0 + HOUR), BIG)
    await takeSnapshot(store, 'fresh', a, NS, 'c', new Date(T0 + 12 * HOUR), BIG)

    c.set(T0 + 26 * HOUR)
    // An operation on one account's list lets go of every account's expired snapshots: nobody has to come back for it.
    expect(store.list('fresh')).toHaveLength(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith(2)
    expect(store.list('old-1')).toEqual([])
    expect(store.list('old-2')).toEqual([])
  })

  it('gives the memory back on its own when nobody asks', async () => {
    vi.useFakeTimers()
    try {
      const a = adapter()
      const onExpire = vi.fn()
      const store = new SnapshotStore({ sweepIntervalMs: 60_000, onExpire })
      await takeSnapshot(store, 's', a, NS, 'one', new Date(), BIG)
      await vi.advanceTimersByTimeAsync(SNAPSHOT_TTL_MS - HOUR)
      expect(onExpire).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2 * HOUR)
      expect(onExpire).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
