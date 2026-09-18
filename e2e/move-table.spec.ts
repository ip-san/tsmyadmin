import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

/** Runs setup / cleanup SQL through the app's own SQL route (errors tolerated: objects may already be gone). */
async function sql(page: Page, t: Target, statement: string) {
  await page.request
    .post(`/api/databases/${t.database}/sql`, { data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) } })
    .catch(() => undefined)
}

for (const t of TARGETS) {
  test.describe(`move table (${t.dialect})`, () => {
    test('moves a table to another database / schema and follows it there', async ({ page }) => {
      await login(page, t)
      const suffix = Date.now().toString(36)
      const table = `e2e_mv_${suffix}`
      // MySQL moves between databases (the fixture has a second one); PostgreSQL between schemas of one database.
      const target = t.dialect === 'mysql' ? 'tsmyadmin_other' : `e2e_sch_${suffix}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY)`)
      if (t.dialect === 'postgres') await sql(page, t, `CREATE SCHEMA ${target}`)
      try {
        await page.goto(tableUrl(t, table, '/operations'))
        await page.getByLabel(t.dialect === 'mysql' ? '移動先のデータベース' : '移動先のスキーマ').selectOption(target)
        await page.getByRole('button', { name: 'テーブルを移動' }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /RENAME TABLE/ : /SET SCHEMA/)
        // The page follows the table to where it went.
        await expect(page).toHaveURL(
          t.dialect === 'mysql'
            ? new RegExp(`/db/${target}/table/${table}`)
            : new RegExp(`/db/${t.database}/table/${table}\\?schema=${target}`)
        )
        await expect(page.getByRole('heading', { name: table })).toBeVisible()
      } finally {
        // Qualified by the database (MySQL) or schema (PostgreSQL) it was moved to.
        await sql(page, t, `DROP TABLE IF EXISTS ${target}.${table}`)
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
        if (t.dialect === 'postgres') await sql(page, t, `DROP SCHEMA IF EXISTS ${target}`)
      }
    })
  })
}
