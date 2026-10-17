import type { Browser, BrowserContext, Page } from '@playwright/test'
import { login, type Target } from './helpers.ts'

/**
 * A chain of lock waits on a scratch table, from three more sessions: A holds row 1; B holds row 2 and waits for
 * row 1; C waits for row 2. So C waits for B, which waits for A, and A is where it starts. `end` drops it all
 * (the caller ends A first if it wants the waits to clear sooner than their timeouts).
 */
export async function lockChain(page: Page, browser: Browser, t: Target) {
  const table = `e2e_chain_${Date.now().toString(36)}`
  const run = (p: Page, statement: string) =>
    p.request.post(`/api/databases/${t.database}/sql`, {
      data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
    })
  await run(page, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
  await run(page, `INSERT INTO ${table} VALUES (1, 0), (2, 0)`)
  const contexts: BrowserContext[] = []
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
  const running = [run(a, `${begin}; UPDATE ${table} SET v = 1 WHERE id = 1; ${sleep} /* e2e_chain_a */`)]
  await page.waitForTimeout(400)
  running.push(
    run(
      b,
      `${timeout}; ${begin}; UPDATE ${table} SET v = 1 WHERE id = 2; UPDATE ${table} SET v = 2 WHERE id = 1 /* e2e_chain_b */`
    )
  )
  await page.waitForTimeout(400)
  running.push(run(c, `${timeout}; UPDATE ${table} SET v = 3 WHERE id = 2 /* e2e_chain_c */`))
  return {
    table,
    async end() {
      await Promise.all(running.map((r) => r.catch(() => undefined)))
      for (const context of contexts) await context.close()
      await run(page, `DROP TABLE IF EXISTS ${table}`)
    },
  }
}
