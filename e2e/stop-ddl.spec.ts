import { type Browser, expect, type Page } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, TARGETS, type Target, tableUrl, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

type Process = { id: string; state: string | null; query: string | null }
const processes = async (page: Page) => {
  const res = await page.request.get('/api/server/processes')
  return res.ok() ? ((await res.json()) as Process[]) : []
}

/**
 * Another session keeps a transaction open on the table: a plain CREATE INDEX (PostgreSQL) or ALTER TABLE (MySQL's
 * metadata lock) waits for it to end, and so does a build that does not stop writes (PostgreSQL: once its index is
 * made, it waits for the transactions before it). Held once it sleeps; `release` ends it.
 */
async function hold(page: Page, browser: Browser, t: Target, table: string) {
  const marker = `${table}_holder`
  const context = await browser.newContext()
  const other = await context.newPage()
  let holder: string | undefined
  await login(other, t)
  const begin = t.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
  const sleep = t.dialect === 'mysql' ? 'SELECT SLEEP(40)' : 'SELECT pg_sleep(40)'
  // Caught at once: ended by `release`, its request fails, and nothing waits on it before then.
  const holding = other.request
    .post(`/api/databases/${t.database}/sql`, {
      data: {
        sql: `${begin}; UPDATE ${table} SET v = 1 WHERE id = 1; ${sleep} /* ${marker} */`,
        ...(t.schema ? { schema: t.schema } : {}),
      },
    })
    .catch(() => undefined)
  const release = async () => {
    // The holder's session ended (its transaction with it), so the table can be built on or dropped at once.
    if (holder) {
      const end = t.dialect === 'mysql' ? `KILL ${holder}` : `SELECT pg_terminate_backend(${holder})`
      await sqlOn(page, t, end).catch(() => undefined)
      holder = undefined
    }
    await holding.catch(() => undefined)
    await context.close().catch(() => undefined)
  }
  try {
    // Holding once it sleeps: its UPDATE is done (MySQL says `User sleep`, PostgreSQL pg_sleep's `Timeout`).
    await expect
      .poll(
        async () => {
          holder = (await processes(page)).find(
            (p) => p.query?.includes(marker) && /sleep|timeout/i.test(p.state ?? '')
          )?.id
          return holder
        },
        { timeout: 15_000 }
      )
      .toBeDefined()
  } catch (err) {
    await release()
    throw err
  }
  return release
}

/** The index form of the table's Structure, filled in for `v`, its preview run, and stopped once the server has it. */
async function stopBuild(page: Page, t: Target, table: string, online: boolean) {
  await page.goto(tableUrl(t, table, '/structure'))
  await page.getByRole('button', { name: 'インデックスを追加' }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('v', { exact: true }).check()
  await form.getByLabel('書き込みを止めずに作る').setChecked(online)
  await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
  const preview = page.getByRole('dialog')
  await expect(preview.getByLabel('SQL')).toContainText(/(CREATE INDEX|ADD INDEX)/)
  await preview.getByRole('button', { name: '実行する' }).click()
  // Stopped once the server has the build waiting, not before it is sent.
  await expect
    .poll(async () => (await processes(page)).some((p) => p.query?.includes(`idx_${table}_v`)), { timeout: 15_000 })
    .toBe(true)
  await preview.getByRole('button', { name: '実行を止める' }).click()
  await expect(preview.getByRole('alert')).toContainText('実行を止めました')
  await expect(preview.getByRole('button', { name: '実行を止める' })).toHaveCount(0)
  return preview
}

// A build that waits on another session's lock is long on any version: stopped from the preview, the server ends it.
for (const t of TARGETS) {
  test.describe(`stopping a DDL run (${t.dialect})`, () => {
    test('stops an index build that waits, from the preview, and leaves no index', async ({ page, browser }) => {
      await login(page, t)
      const table = scratchName('e2e_stop')
      let release: () => Promise<void> = async () => undefined
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
      try {
        await sqlOn(page, t, `INSERT INTO ${table} VALUES (1, 0)`)
        release = await hold(page, browser, t, table)
        const preview = await stopBuild(page, t, table, false)
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])
        await preview.getByRole('button', { name: 'キャンセル' }).click()
        // Read anew from the server, its primary key there: the build stopped left no index.
        await page.reload()
        const indexes = page.getByRole('table', { name: 'インデックス' })
        await expect(indexes.getByRole('row').filter({ hasText: /PRIMARY|_pkey/ })).toHaveCount(1)
        await expect(indexes.getByRole('row').filter({ hasText: `idx_${table}_v` })).toHaveCount(0)
      } finally {
        await release()
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    // PostgreSQL: a build that does not stop writes, stopped, leaves an unusable index of its name (MySQL's leaves
    // nothing). Run again, the SQL is built anew and drops it first.
    test('runs again a build stopped without stopping writes, dropping first the index it left', async ({
      page,
      browser,
    }) => {
      test.skip(t.dialect !== 'postgres', 'only PostgreSQL leaves an index from a build cut short')
      await login(page, t)
      const table = scratchName('e2e_stopc')
      let release: () => Promise<void> = async () => undefined
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
      try {
        await sqlOn(page, t, `INSERT INTO ${table} VALUES (1, 0)`)
        release = await hold(page, browser, t, table)
        const preview = await stopBuild(page, t, table, true)
        await expect(preview.getByLabel('SQL')).not.toContainText('DROP INDEX')
        // Let go first: built again, it would wait as long.
        await release()
        await preview.getByRole('button', { name: '実行する' }).click()
        await expect(preview.getByRole('status').filter({ hasText: 'SQL を作り直しました' })).toBeVisible()
        await expect(preview.getByLabel('SQL')).toContainText(
          `DROP INDEX CONCURRENTLY IF EXISTS ${t.schema ? `"${t.schema}".` : ''}"idx_${table}_v"`
        )
        await expect(preview.getByRole('alert')).toHaveCount(0)
        await preview.getByRole('button', { name: '実行する' }).click()
        await expect(page.getByText('「インデックスを追加」を実行しました')).toBeVisible()
        await page.reload()
        const indexes = page.getByRole('table', { name: 'インデックス' })
        await expect(indexes.getByRole('row').filter({ hasText: `idx_${table}_v` })).toHaveCount(1)
        await expect(page.getByRole('region', { name: '使えないインデックス' })).toHaveCount(0)
      } finally {
        await release()
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
