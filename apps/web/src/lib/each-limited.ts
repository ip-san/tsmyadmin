/** What one item came to: its value, or the error it failed with (the others go on). */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown }

/**
 * Runs `work` for every item, at most `limit` at a time, and gives what each came to, in the items' order. For
 * requests sent per table: a database of two hundred tables must not send two hundred at once, and one that fails
 * (a timeout, say) leaves the others' answers standing. Once `signal` aborts (turned off, the page left), no more
 * items are started; those not started are left out of the result.
 */
export async function eachLimited<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  { limit = 4, signal }: { limit?: number; signal?: AbortSignal | undefined } = {}
): Promise<{ item: T; settled: Settled<R> }[]> {
  const out = new Map<number, Settled<R>>()
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length && !signal?.aborted; i = next++) {
      out.set(
        i,
        await work(items[i] as T).then(
          (value): Settled<R> => ({ ok: true, value }),
          (error: unknown): Settled<R> => ({ ok: false, error })
        )
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return items.flatMap((item, i) => {
    const settled = out.get(i)
    return settled ? [{ item, settled }] : []
  })
}
