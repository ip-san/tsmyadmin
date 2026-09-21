import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

async function scan(page: Page) {
  const problems = await pageProblems(page)
  expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
  expect(problems.layout, 'layout').toEqual([])
}

async function sql(page: Page, t: Target, statement: string, database = t.database, schema?: string) {
  const res = await page.request.post(`/api/databases/${database}/sql`, {
    data: { sql: statement, stopOnError: true, ...(schema ? { schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`snapshots (${t.dialect})`, () => {
    test('saves a database, puts it back after a change, and drops what was made since', async ({ page }) => {
      test.setTimeout(90_000)
      await login(page, t)
      const scratch = `e2e_snap_${Date.now().toString(36)}`
      // A database of its own on MySQL, a schema of the shared database on PostgreSQL: the fixtures stay as they are.
      const mysql = t.dialect === 'mysql'
      const db = mysql ? scratch : t.database
      const schema = mysql ? undefined : scratch
      if (mysql) await sql(page, t, `CREATE DATABASE ${scratch}`)
      else await sql(page, t, `CREATE SCHEMA ${scratch}`)
      const run = (statement: string) => sql(page, t, statement, db, schema)
      try {
        await run("CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO items VALUES (1, 'one')")
        await page.goto(`/db/${db}/snapshots${schema ? `?schema=${schema}` : ''}`)
        await expect(page.getByText('まだありません。')).toBeVisible()
        await scan(page)

        await page.getByLabel('名前', { exact: true }).fill('マイグレーション前')
        await page.getByRole('button', { name: 'スナップショットを取る' }).click()
        const list = page.getByRole('table', { name: '保存したスナップショット' })
        await expect(list.getByRole('cell', { name: 'マイグレーション前', exact: true })).toBeVisible()
        await scan(page)

        // Changes after it: a row edited, a table made.
        await run("UPDATE items SET name = 'changed'; CREATE TABLE later (id INT)")

        await page.getByRole('button', { name: 'マイグレーション前: 復元…' }).click()
        await expect(page.getByRole('dialog').getByLabel('SQL')).toBeVisible()
        await scan(page)
        // What was made since is dropped, and the dialog says what else runs.
        await confirmPreview(page, /DROP TABLE IF EXISTS .*later/, 'マイグレーション前')
        await expect(page.getByText('「マイグレーション前」に戻しました。')).toBeVisible()

        const rows = await (
          await page.request.get(`/api/databases/${db}/tables/items/rows${schema ? `?schema=${schema}` : ''}`)
        ).json()
        expect(rows.rows).toEqual([[1, 'one']])
        const gone = await page.request.get(
          `/api/databases/${db}/tables/later/rows${schema ? `?schema=${schema}` : ''}`
        )
        expect(gone.status()).toBe(404)

        await page.getByRole('button', { name: 'マイグレーション前: 削除' }).click()
        await expect(page.getByText('まだありません。')).toBeVisible()
      } finally {
        if (mysql) await sql(page, t, `DROP DATABASE IF EXISTS ${scratch}`)
        else await sql(page, t, `DROP SCHEMA IF EXISTS ${scratch} CASCADE`)
      }
    })
  })
}
