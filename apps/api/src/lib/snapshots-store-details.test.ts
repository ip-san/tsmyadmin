import { describe, expect, it, vi } from 'vitest'
import { caught } from '../test/caught.ts'
import { SNAPSHOT_MAX_COUNT, SNAPSHOT_TTL_MS, SnapshotError, SnapshotStore } from './snapshots.ts'

/**
 * What the snapshot store keeps, for whom, and when it lets go (found as surviving mutants; see `bun run mutation`).
 * The store is driven directly with dumps of known size and a clock the test moves by hand.
 */

const T0 = Date.UTC(2026, 0, 1)
const HOUR = 60 * 60_000
const user = { host: 'db', port: 3306, user: 'root' }

function clock() {
  let t = T0
  return {
    now: () => t,
    set: (v: number) => {
      t = v
    },
  }
}

/** A store whose clock stands at T0 unless a test moves it, so the snapshots made "at T0" are new. */
const mk = (options: ConstructorParameters<typeof SnapshotStore>[0] = {}) =>
  new SnapshotStore({ now: () => T0, sweepIntervalMs: 0, ...options })

/** A dump of exactly `bytes` bytes. */
const dump = (bytes: number, names: string[] = ['t']) => ({
  sql: 'x'.repeat(bytes),
  statements: 1,
  names: new Set(names),
})
const taken = (store: SnapshotStore, scope: string, name: string, bytes = 10, at = new Date(T0)) =>
  store.add(scope, dump(bytes), name, at)

describe('SnapshotStore.scope', () => {
  it('tells accounts, hosts, ports, databases and schemas apart', () => {
    const ns = { database: 'd', schema: 'a' }
    const base = SnapshotStore.scope(user, ns)
    expect(SnapshotStore.scope({ ...user, user: 'other' }, ns)).not.toBe(base)
    expect(SnapshotStore.scope({ ...user, host: 'other' }, ns)).not.toBe(base)
    expect(SnapshotStore.scope({ ...user, port: 3307 }, ns)).not.toBe(base)
    expect(SnapshotStore.scope(user, { database: 'e', schema: 'a' })).not.toBe(base)
    expect(SnapshotStore.scope(user, { database: 'd', schema: 'b' })).not.toBe(base)
    expect(SnapshotStore.scope(user, { database: 'd' })).not.toBe(base)
    expect(SnapshotStore.scope(user, { database: 'd' })).not.toBe(
      SnapshotStore.scope(user, { database: 'd', schema: 'b' })
    )
  })

  it('treats a missing schema and an empty one alike', () => {
    expect(SnapshotStore.scope(user, { database: 'd' })).toBe(SnapshotStore.scope(user, { database: 'd', schema: '' }))
  })

  it('does not run the parts of a name together', () => {
    expect(SnapshotStore.scope({ ...user, host: 'a', user: 'bc' }, { database: 'd' })).not.toBe(
      SnapshotStore.scope({ ...user, host: 'ab', user: 'c' }, { database: 'd' })
    )
  })
})

describe('adding', () => {
  it('numbers the snapshots 1, 2, 3 and says what each holds', () => {
    const store = mk()
    const at = new Date(T0 + 1234)
    const a = store.add('s', dump(5, ['x', 'y']), 'first', at)
    expect(a).toEqual({ id: '1', name: 'first', at: at.toISOString(), bytes: 5, objects: 2 })
    expect(taken(store, 's', 'second').id).toBe('2')
    expect(taken(store, 'other', 'third').id).toBe('3')
  })

  it('counts a dump in bytes, not characters', () => {
    const store = mk()
    expect(store.add('s', { sql: 'あい', statements: 1, names: new Set() }, 'n', new Date()).bytes).toBe(6)
  })

  it('keeps ten for a database, and says so', async () => {
    const store = mk()
    for (let i = 0; i < SNAPSHOT_MAX_COUNT; i++) taken(store, 's', `n${i}`, 1)
    const e = await caught<SnapshotError>(() => taken(store, 's', 'eleventh', 1))
    expect(e).toBeInstanceOf(SnapshotError)
    expect(e).toMatchObject({ reason: 'TOO_MANY', message: 'A database keeps at most 10 snapshots: remove one first' })
    // Another database has its own ten.
    expect(taken(store, 'other', 'n', 1).name).toBe('n')
    expect(store.list('s')).toHaveLength(SNAPSHOT_MAX_COUNT)
  })

  it('keeps the total of what is held to the limit: the last byte fits, one more does not', () => {
    const store = mk({ totalLimit: 30 })
    taken(store, 'a', 'one', 10)
    taken(store, 'b', 'two', 20)
    expect(() => taken(store, 'c', 'three', 1)).toThrowError(/total limit/)
    const small = mk({ totalLimit: 15 })
    taken(small, 'a', 'one', 10)
    // 10 held + 10 more is 20 > 15, though 10 alone is not.
    try {
      taken(small, 'b', 'two', 10)
      expect.unreachable()
    } catch (e) {
      expect((e as SnapshotError).reason).toBe('FULL')
    }
    expect(small.list('b')).toEqual([])
  })

  it('counts what is being taken against the total as well', () => {
    const store = mk({ totalLimit: 30 })
    const room = store.reserve(25)
    expect(() => taken(store, 'a', 'one', 10)).toThrowError(/total limit/)
    room.release()
    expect(taken(store, 'a', 'one', 10).bytes).toBe(10)
  })
})

describe('listing, finding and removing', () => {
  it('lists an account only what it took, in the order taken', () => {
    const store = mk()
    taken(store, 'a', 'one')
    taken(store, 'b', 'other')
    taken(store, 'a', 'two')
    expect(store.list('a').map((s) => s.name)).toEqual(['one', 'two'])
    expect(store.list('b').map((s) => s.name)).toEqual(['other'])
    expect(store.list('nobody')).toEqual([])
  })

  it('finds the one asked for by its ID, and only within the account', () => {
    const store = mk()
    const one = taken(store, 'a', 'one')
    const two = taken(store, 'a', 'two')
    expect(store.get('a', two.id)?.snapshot.name).toBe('two')
    expect(store.get('a', one.id)?.snapshot.name).toBe('one')
    expect(store.get('a', '99')).toBeUndefined()
    expect(store.get('b', one.id)).toBeUndefined()
  })

  it('removes the one asked for and leaves the others', () => {
    const store = mk()
    const one = taken(store, 'a', 'one')
    const two = taken(store, 'a', 'two')
    expect(store.remove('a', one.id)).toBe(true)
    expect(store.list('a').map((s) => s.name)).toEqual(['two'])
    expect(store.remove('a', one.id)).toBe(false)
    expect(store.remove('b', two.id)).toBe(false)
    expect(store.list('a')).toHaveLength(1)
    expect(store.remove('a', two.id)).toBe(true)
    expect(store.list('a')).toEqual([])
    expect(store.get('a', two.id)).toBeUndefined()
  })

  it('gives the room of a removed one back', () => {
    const store = mk({ totalLimit: 20 })
    const one = taken(store, 'a', 'one', 20)
    expect(() => taken(store, 'b', 'two', 1)).toThrowError(/total limit/)
    store.remove('a', one.id)
    expect(taken(store, 'b', 'two', 20).bytes).toBe(20)
  })
})

describe('letting go of the old ones, whichever operation comes first', () => {
  it('is a day, to the millisecond: one that is exactly a day old is gone', () => {
    const c = clock()
    const store = new SnapshotStore({ now: c.now, sweepIntervalMs: 0 })
    taken(store, 'a', 'one')
    c.set(T0 + SNAPSHOT_TTL_MS - 1)
    expect(store.list('a')).toHaveLength(1)
    c.set(T0 + SNAPSHOT_TTL_MS)
    expect(store.list('a')).toEqual([])
  })

  it('get does not return one that has expired', () => {
    const c = clock()
    const store = new SnapshotStore({ now: c.now, sweepIntervalMs: 0 })
    const one = taken(store, 'a', 'one')
    c.set(T0 + SNAPSHOT_TTL_MS + 1)
    expect(store.get('a', one.id)).toBeUndefined()
  })

  it('remove says "not found" for one that has expired', () => {
    const c = clock()
    const store = new SnapshotStore({ now: c.now, sweepIntervalMs: 0 })
    const one = taken(store, 'a', 'one')
    c.set(T0 + SNAPSHOT_TTL_MS + 1)
    expect(store.remove('a', one.id)).toBe(false)
  })

  it('reserve counts only what has not expired', () => {
    const c = clock()
    const store = new SnapshotStore({ totalLimit: 100, now: c.now, sweepIntervalMs: 0 })
    taken(store, 'a', 'one', 60)
    c.set(T0 + SNAPSHOT_TTL_MS + 1)
    expect(store.reserve(100).limit).toBe(100)
  })

  it('add does not count the ten that have expired', () => {
    const c = clock()
    const store = new SnapshotStore({ totalLimit: 1000, now: c.now, sweepIntervalMs: 0 })
    for (let i = 0; i < SNAPSHOT_MAX_COUNT; i++) taken(store, 'a', `n${i}`, 1)
    c.set(T0 + SNAPSHOT_TTL_MS + 1)
    expect(taken(store, 'a', 'new', 1, new Date(c.now())).name).toBe('new')
    expect(store.list('a').map((s) => s.name)).toEqual(['new'])
  })

  it('add does not count the bytes of ones that have expired', () => {
    const c = clock()
    const store = new SnapshotStore({ totalLimit: 20, now: c.now, sweepIntervalMs: 0 })
    taken(store, 'a', 'old', 20)
    c.set(T0 + SNAPSHOT_TTL_MS + 1)
    expect(taken(store, 'b', 'new', 20, new Date(c.now())).bytes).toBe(20)
  })

  it('lets go of the old ones of an account and keeps its newer ones, counting only those let go', () => {
    const c = clock()
    const onExpire = vi.fn()
    const store = new SnapshotStore({ now: c.now, sweepIntervalMs: 0, onExpire })
    taken(store, 'a', 'old-1', 1, new Date(T0))
    taken(store, 'a', 'old-2', 1, new Date(T0 + HOUR))
    taken(store, 'a', 'fresh', 1, new Date(T0 + 12 * HOUR))
    c.set(T0 + 26 * HOUR)
    expect(store.list('a').map((s) => s.name)).toEqual(['fresh'])
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith(2)
    // Nothing more to let go of: nobody is told again.
    store.list('a')
    expect(onExpire).toHaveBeenCalledTimes(1)
    // The one that stayed can still be found, and removed.
    expect(store.remove('a', '3')).toBe(true)
  })
})

describe('the timer that gives the memory back', () => {
  it('runs every ten minutes unless told otherwise, not every millisecond', async () => {
    vi.useFakeTimers()
    try {
      const c = clock()
      const onExpire = vi.fn()
      const store = new SnapshotStore({ now: () => c.now() + 3 * SNAPSHOT_TTL_MS, onExpire })
      // Held, though old already: the store's own clock says it expired long ago.
      store.add('a', dump(1), 'one', new Date(T0))
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(onExpire).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(onExpire).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
