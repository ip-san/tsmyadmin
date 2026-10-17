import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test'
import { login, scratchName, sqlOn, type Target } from './helpers.ts'

/**
 * A chain of lock waits on a scratch table, from three more sessions: A holds row 1; B holds row 2 and waits for
 * row 1; C waits for row 2. So C waits for B, which waits for A, and A is where it starts. Each session starts once
 * the one before is seen at its statement in the process list (not after a guessed pause). `end` drops it all
 * (the caller ends A first if it wants the waits to clear sooner than their timeouts).
 */
export async function lockChain(page: Page, browser: Browser, t: Target) {
  const table = scratchName('e2e_chain')
  const marker = (session: 'a' | 'b' | 'c') => `${table}_${session}`
  // The chain's own statements: they wait, and may end in a lock timeout, which is not a failed setup.
  const run = (p: Page, statement: string) =>
    p.request.post(`/api/databases/${t.database}/sql`, {
      data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
    })
  await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
  await sqlOn(page, t, `INSERT INTO ${table} VALUES (1, 0), (2, 0)`)
  /** The server's id of the session running the statement marked `session`, once it is running it. */
  const idOf = async (session: 'a' | 'b' | 'c') => {
    let id: string | undefined
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/server/processes')
          const list = res.ok() ? ((await res.json()) as { id: string; query: string | null }[]) : []
          id = list.find((p) => p.query?.includes(marker(session)))?.id
          return id
        },
        { timeout: 15_000 }
      )
      .toBeDefined()
    return id as string
  }
  const contexts: BrowserContext[] = []
  const running: Promise<unknown>[] = []
  const end = async () => {
    await Promise.all(running.map((r) => r.catch(() => undefined)))
    for (const context of contexts) await context.close().catch(() => undefined)
    await sqlOn(page, t, `DROP TABLE IF EXISTS ${table}`)
  }
  try {
    const session = async () => {
      const context = await browser.newContext()
      contexts.push(context)
      const p = await context.newPage()
      await login(p, t)
      return p
    }
    const [a, b, c] = [await session(), await session(), await session()]
    const begin = t.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
    const sleep = t.dialect === 'mysql' ? 'SELECT SLEEP(25)' : 'SELECT pg_sleep(25)'
    const timeout = t.dialect === 'mysql' ? 'SET SESSION innodb_lock_wait_timeout = 25' : "SET lock_timeout = '25s'"
    running.push(run(a, `${begin}; UPDATE ${table} SET v = 1 WHERE id = 1; ${sleep} /* ${marker('a')} */`))
    const holder = await idOf('a')
    running.push(
      run(
        b,
        `${timeout}; ${begin}; UPDATE ${table} SET v = 1 WHERE id = 2; UPDATE ${table} SET v = 2 WHERE id = 1 /* ${marker('b')} */`
      )
    )
    await idOf('b')
    running.push(run(c, `${timeout}; UPDATE ${table} SET v = 3 WHERE id = 2 /* ${marker('c')} */`))
    await idOf('c')
    return {
      table,
      /** The marker in each session's statement, unique to this chain: other chains may be running at the same time. */
      marker,
      /** A's id: where this chain starts. */
      holder,
      end,
    }
  } catch (err) {
    await end()
    throw err
  }
}
