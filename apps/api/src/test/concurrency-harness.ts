/**
 * For tests that fire the same operation many times at once and then check what must stay true whatever the order:
 * at most so many accepted, nothing lost, never more held than the cap.
 *
 * A burst in one process only interleaves where the code awaits, and a store that answers synchronously (node:sqlite)
 * gives the event loop few chances to switch. `widen` makes those chances certain: every call to the named methods
 * waits a moment first, so all requests of a burst finish their read before any of them writes — the order a slow
 * store or a busy server produces, and the one a read-modify-write that is not atomic gets wrong.
 */

/** Starts `n` calls of `run` together (none waits for another) and settles them all. */
export function concurrently<T>(n: number, run: (i: number) => T | PromiseLike<T>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: n }, (_, i) => Promise.resolve(run(i))))
}

/** The values of the calls that resolved; fails the test with the first reason when one rejected. */
export function fulfilled<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.map((r) => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  })
}

/** How many responses answered with each status, e.g. `{ 201: 1, 401: 9 }`. */
export function countStatuses(responses: readonly Response[]): Record<number, number> {
  const out: Record<number, number> = {}
  for (const { status } of responses) out[status] = (out[status] ?? 0) + 1
  return out
}

type AsyncMethod = (...args: never[]) => Promise<unknown>
type AsyncMethodsOf<T> = { [K in keyof T]: T[K] extends AsyncMethod ? K : never }[keyof T]

/** One turn of the timer queue: every promise already started gets to run up to its next await. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 1))

/** How long a call held for its cohort waits for the others before it goes on alone (a burst smaller than asked). */
const COHORT_WAIT_MS = 200

/**
 * Calls wait here until `size` of them have arrived, then all go on together: a read that every request of a burst
 * makes before any of them writes, however far apart the requests got on their way to it.
 */
function cohorts(size: number): () => Promise<void> {
  let waiting: (() => void)[] = []
  const release = (cohort: (() => void)[]) => {
    if (waiting === cohort) waiting = []
    for (const go of cohort.splice(0)) go()
  }
  return () =>
    new Promise<void>((resolve) => {
      const cohort = waiting
      cohort.push(resolve)
      if (cohort.length >= size) release(cohort)
      else if (cohort.length === 1) setTimeout(() => release(cohort), COHORT_WAIT_MS)
    })
}

/**
 * Makes each of `methods` on `target` wait before it runs (the instance is changed in place, like the tests that
 * replace `store.create`): a turn of the event loop, or with `together`, until that many calls of the method are
 * waiting. Returns a way to put them back.
 */
export function widen<T extends object>(
  target: T,
  methods: readonly AsyncMethodsOf<T>[],
  options: { together?: number } = {}
): () => void {
  const originals = new Map<PropertyKey, unknown>()
  const record = target as Record<PropertyKey, unknown>
  for (const name of methods) {
    const original = record[name] as (...args: unknown[]) => Promise<unknown>
    originals.set(name, Object.hasOwn(target, name) ? original : undefined)
    const wait = options.together === undefined ? turn : cohorts(options.together)
    record[name] = async (...args: unknown[]) => {
      await wait()
      return original.apply(target, args)
    }
  }
  return () => {
    for (const [name, original] of originals) {
      if (original === undefined) delete record[name]
      else record[name] = original
    }
  }
}

/** The highest number of calls of `run` in progress at once, counted while the returned wrapper is used. */
export function peakInFlight<A extends unknown[], R>(run: (...args: A) => Promise<R>) {
  let now = 0
  let peak = 0
  const wrapped = async (...args: A): Promise<R> => {
    now++
    peak = Math.max(peak, now)
    try {
      return await run(...args)
    } finally {
      now--
    }
  }
  return { run: wrapped, peak: () => peak }
}
