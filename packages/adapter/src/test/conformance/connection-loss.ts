import { describe, expect, it } from 'vitest'
import { AdapterError } from '../../types.ts'
import type { ConformanceEnv } from './env.ts'
import { EXEC } from './helpers.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls until `read` returns something (or the time is up): the server shows a statement a moment after it starts. */
async function until<T>(read: () => Promise<T | undefined>, ms = 5_000): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) {
    const found = await read()
    if (found !== undefined || Date.now() > end) return found
    await sleep(50)
  }
}

/**
 * Conformance: a server-side connection that dies under the adapter (an administrator's KILL / pg_terminate_backend,
 * a restart, a proxy that drops it). The connections are ended from a second adapter, the way an administrator would;
 * no container is stopped. What must hold: the statement that was running ends as CONNECTION_FAILED (never as a
 * query the caller got wrong, never a hang), and the session's pool replaces the dead connection so the next
 * request works.
 */
export function describeConnectionLoss(env: ConformanceEnv): void {
  const { ctx, ns, dialect } = env
  const slow = (marker: string) =>
    dialect === 'mysql' ? `SELECT SLEEP(30) /* ${marker} */` : `SELECT pg_sleep(30) /* ${marker} */`
  const idOf = dialect === 'mysql' ? 'SELECT CONNECTION_ID() + SLEEP(0.4) AS id' : 'SELECT pg_backend_pid() AS id'

  describe('connection loss', () => {
    it('ends a statement whose connection is killed as CONNECTION_FAILED, and the session recovers', async () => {
      const victim = ctx.create()
      try {
        const marker = `lost_${Date.now().toString(36)}`
        const running = victim.executeSql(ns, slow(marker), { ...EXEC, timeoutMs: 60_000 }).then(
          (results) => ({ results }),
          (error: unknown) => ({ error })
        )
        const process = await until(async () =>
          (await env.db.listProcesses()).find((p) => (p.query ?? '').includes(marker))
        )
        expect(process, 'the statement never showed in the process list').toBeDefined()
        if (process) await env.db.killProcess(process.id, 'connection')

        const outcome = await Promise.race([running, sleep(10_000).then(() => ({ hung: true }))])
        expect(outcome).not.toHaveProperty('hung')
        const failure =
          'error' in outcome
            ? outcome.error
            : 'results' in outcome && outcome.results[0]?.kind === 'error'
              ? outcome.results[0]
              : undefined
        expect(failure, `expected the statement to fail, got ${JSON.stringify(outcome)}`).toBeDefined()
        expect(failure).toMatchObject({ code: 'CONNECTION_FAILED' })

        // The next request gets a working connection, not the dead one.
        await expect(victim.listTables(ns)).resolves.toBeDefined()
        const again = await victim.executeSql(ns, 'SELECT 1 AS one', EXEC)
        expect(again[0]?.kind).toBe('rows')
      } finally {
        await victim.close()
      }
    }, 30_000)

    it('replaces idle pooled connections that were killed, with no request failing', async () => {
      const victim = ctx.create()
      try {
        // Four overlapping statements force four connections into the pool; each reports its own backend id.
        const ids = new Set<string>()
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            const results = await victim.executeSql(ns, idOf, EXEC)
            const first = results[0]
            if (first?.kind !== 'rows') throw new Error('no rows')
            ids.add(String(first.result.rows[0]?.[0]))
          })
        )
        expect(ids.size).toBeGreaterThan(1)
        for (const id of ids) await env.db.killProcess(id, 'connection').catch(() => undefined)

        // Straight away, with no pause for the socket close to arrive: this is the race that sends a request to a
        // dead connection. Several requests in a row, so each of the dead ones is met.
        const outcomes: string[] = []
        for (let i = 0; i < 6; i++) {
          outcomes.push(
            await victim.listTables(ns).then(
              () => 'ok',
              (e: unknown) => (e instanceof AdapterError ? e.code : 'other')
            )
          )
        }
        // A request that lands on a connection killed a moment ago may be told the connection is gone, but only
        // that, and only until the pool has dropped the dead ones.
        expect(outcomes.filter((o) => o !== 'ok' && o !== 'CONNECTION_FAILED')).toEqual([])
        expect(outcomes.at(-1)).toBe('ok')
        expect(outcomes.slice(-3)).toEqual(['ok', 'ok', 'ok'])
      } finally {
        await victim.close()
      }
    }, 30_000)
  })
}
