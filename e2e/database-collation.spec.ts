import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string, database = t.database) {
  const res = await page.request.post(`/api/databases/${database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`database collation (${t.dialect})`, () => {
    test('changes the default collation and converts the tables and their text columns', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const scratch = `e2e_coll_${Date.now().toString(36)}`
      // A database of its own on MySQL, a schema of the shared database on PostgreSQL: the fixtures stay as they are.
      const mysql = t.dialect === 'mysql'
      const url = mysql ? `/db/${scratch}/operations` : `/db/${t.database}/operations?schema=${scratch}`
      if (mysql) await sql(page, t, `CREATE DATABASE ${scratch}`, t.database)
      else await sql(page, t, `CREATE SCHEMA ${scratch}`)
      const inside = mysql ? scratch : `${scratch}`
      await page.request.post(`/api/databases/${mysql ? scratch : t.database}/sql`, {
        data: {
          sql: `CREATE TABLE ${mysql ? '' : `${inside}.`}items (id INT PRIMARY KEY, name VARCHAR(20))`,
          ...(mysql ? {} : { schema: scratch }),
        },
      })
      try {
        await page.goto(url)
        const form = page.getByRole('form', { name: '既定の照合順序を変更' })
        await form.getByLabel('照合順序').fill(mysql ? 'utf8mb4_bin' : 'C')
        if (mysql) await form.getByLabel('既存のテーブル・カラムにも反映する').check()
        await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, mysql ? /CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/ : /COLLATE "C"/)
        const [row] = (
          await (
            await page.request.get(
              `/api/databases/${mysql ? scratch : t.database}/tables/items/structure${mysql ? '' : `?schema=${scratch}`}`
            )
          ).json()
        ).columns.filter((c: { name: string }) => c.name === 'name')
        expect(row.collation).toBe(mysql ? 'utf8mb4_bin' : 'C')
      } finally {
        if (mysql) await sql(page, t, `DROP DATABASE IF EXISTS ${scratch}`)
        else await sql(page, t, `DROP SCHEMA IF EXISTS ${scratch} CASCADE`)
      }
    })
  })
}
