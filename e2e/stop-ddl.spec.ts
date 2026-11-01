import { type BrowserContext, expect } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, TARGETS, tableUrl, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

// A build that waits on another session's lock is long on any version: stopped from the preview, the server ends it
// and the table has no index from it.
for (const t of TARGETS) {
  test.describe(`stopping a DDL run (${t.dialect})`, () => {
    test('stops an index build that waits, from the preview, and leaves no index', async ({ page, browser }) => {
      await login(page, t)
      const table = scratchName('e2e_stop')
      const marker = `${table}_holder`
      const contexts: BrowserContext[] = []
      let holding: Promise<unknown> = Promise.resolve()
      let holder: string | undefined
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
      try {
        await sqlOn(page, t, `INSERT INTO ${table} VALUES (1, 0)`)
        // Another session keeps a transaction open on the table: a plain CREATE INDEX (PostgreSQL) or ALTER TABLE
        // (MySQL's metadata lock) waits for it to end.
        const context = await browser.newContext()
        contexts.push(context)
        const other = await context.newPage()
        await login(other, t)
        const begin = t.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
        const sleep = t.dialect === 'mysql' ? 'SELECT SLEEP(40)' : 'SELECT pg_sleep(40)'
        holding = other.request.post(`/api/databases/${t.database}/sql`, {
          data: {
            sql: `${begin}; UPDATE ${table} SET v = 1 WHERE id = 1; ${sleep} /* ${marker} */`,
            ...(t.schema ? { schema: t.schema } : {}),
          },
        })
        type Process = { id: string; state: string | null; query: string | null }
        const processes = async () => {
          const res = await page.request.get('/api/server/processes')
          return res.ok() ? ((await res.json()) as Process[]) : []
        }
        // Holding once it sleeps: its UPDATE is done (MySQL says `User sleep`, PostgreSQL pg_sleep's `Timeout`).
        await expect
          .poll(
            async () => {
              holder = (await processes()).find(
                (p) => p.query?.includes(marker) && /sleep|timeout/i.test(p.state ?? '')
              )?.id
              return holder
            },
            { timeout: 15_000 }
          )
          .toBeDefined()

        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByRole('button', { name: 'インデックスを追加' }).click()
        const form = page.getByRole('dialog')
        await form.getByLabel('v', { exact: true }).check()
        await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        const preview = page.getByRole('dialog')
        await expect(preview.getByLabel('SQL')).toContainText(/(CREATE INDEX|ADD INDEX)/)
        await preview.getByRole('button', { name: '実行する' }).click()
        // Stopped once the server has the build waiting, not before it is sent.
        await expect
          .poll(async () => (await processes()).some((p) => p.query?.includes(`idx_${table}_v`)), { timeout: 15_000 })
          .toBe(true)
        await preview.getByRole('button', { name: '実行を止める' }).click()
        await expect(preview.getByRole('alert')).toContainText('実行を止めました')
        await expect(preview.getByRole('button', { name: '実行を止める' })).toHaveCount(0)
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])
        await preview.getByRole('button', { name: 'キャンセル' }).click()
        const indexes = page.getByRole('table', { name: 'インデックス' })
        await expect(indexes.getByRole('row').filter({ hasText: `idx_${table}_v` })).toHaveCount(0)
      } finally {
        // The holder's session ended (its transaction with it), so the table can be dropped at once.
        if (holder) {
          const end = t.dialect === 'mysql' ? `KILL ${holder}` : `SELECT pg_terminate_backend(${holder})`
          await sqlOn(page, t, end).catch(() => undefined)
        }
        await holding.catch(() => undefined)
        for (const context of contexts) await context.close().catch(() => undefined)
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
