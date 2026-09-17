import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

/** Runs SQL through the API as the logged-in browser session, failing the test on an HTTP error. */
async function sqlIn(page: Page, database: string, sql: string): Promise<void> {
  const res = await page.request.post(`/api/databases/${database}/sql`, { data: { sql } })
  expect(res.ok()).toBe(true)
}

/** A scratch database with one table and two rows, created from the session's own database. */
async function seedDatabase(page: Page, t: Target, name: string): Promise<void> {
  await sqlIn(page, t.database, `CREATE DATABASE ${name}`)
  // On PostgreSQL this opens a pooled connection to the new database: the rename below must still go through.
  await sqlIn(
    page,
    name,
    "CREATE TABLE items (id INT PRIMARY KEY, v VARCHAR(10)); INSERT INTO items VALUES (1, 'a'), (2, 'b')"
  )
}

async function dropQuietly(page: Page, t: Target, name: string): Promise<void> {
  const force = t.dialect === 'postgres' ? ' WITH (FORCE)' : ''
  await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: `DROP DATABASE IF EXISTS ${name}${force}` },
  })
}

for (const t of TARGETS) {
  test.describe(`database operations (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('renames a database, then copies it with its rows', async ({ page }) => {
      const base = `e2e_dbops_${Date.now().toString(36)}`
      const renamed = `${base}_ren`
      const copied = `${base}_cpy`
      await seedDatabase(page, t, base)
      try {
        await page.goto(`/db/${base}/operations`)
        await page.getByLabel('新しいデータベース名').fill(renamed)
        await page
          .getByRole('form', { name: 'データベースの名前を変更' })
          .getByRole('button', { name: '次へ（SQL を確認）' })
          .click()
        // MySQL moves the tables and keeps the old database: dropping it would also take what the account cannot
        // see, or what was created after this preview.
        if (t.dialect === 'mysql') {
          const statements = page.getByRole('dialog').getByLabel('SQL')
          // Wait for the SQL first, or the negative check could pass against an empty dialog.
          await expect(statements).toContainText('RENAME TABLE')
          await expect(statements).not.toContainText('DROP DATABASE')
        }
        await confirmPreview(page, t.dialect === 'mysql' ? /RENAME TABLE/ : /RENAME TO/, base)
        await expect(page).toHaveURL(new RegExp(`/db/${renamed}$`))
        await expect(page.getByRole('heading', { name: new RegExp(renamed) })).toBeVisible()
        await page.goto('/')
        await expect(page.getByRole('main').getByRole('link', { name: base, exact: true })).toHaveCount(
          t.dialect === 'mysql' ? 1 : 0
        )

        await page.goto(`/db/${renamed}/operations`)
        await page.getByLabel('コピー先のデータベース名').fill(copied)
        await page
          .getByRole('form', { name: 'データベースをコピー' })
          .getByRole('button', { name: '次へ（SQL を確認）' })
          .click()
        await confirmPreview(page, t.dialect === 'mysql' ? /INSERT INTO/ : /TEMPLATE/)
        await expect(page).toHaveURL(new RegExp(`/db/${copied}$`))
        await page.goto(`/db/${copied}/table/items${t.schema ? `?schema=${t.schema}` : ''}`)
        await expect(page.getByText('全 2 行')).toBeVisible()
      } finally {
        for (const name of [base, renamed, copied]) await dropQuietly(page, t, name)
      }
    })

    test('does not offer to rename the server’s own databases', async ({ page }) => {
      await page.goto(`/db/${t.dialect === 'mysql' ? 'mysql' : 'postgres'}/operations`)
      await expect(page.getByText('サーバー自身のデータベースは、名前変更もコピーもできません。')).toBeVisible()
      await expect(page.getByRole('form', { name: 'データベースの名前を変更' })).toHaveCount(0)
      if (t.dialect === 'postgres') {
        // PostgreSQL cannot rename or copy the database a statement runs in: the session's own is refused up front.
        await page.goto(`/db/${t.database}/operations`)
        await expect(page.getByText(/このセッションが接続しているデータベース/)).toBeVisible()
      }
    })
  })
}
