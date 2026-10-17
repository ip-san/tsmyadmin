import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string, database = t.database, schema = t.schema) {
  const res = await page.request.post(`/api/databases/${database}/sql`, {
    data: { sql: statement, ...(schema ? { schema } : {}) },
  })
  expect(res.ok()).toBe(true)
}

for (const t of TARGETS) {
  test.describe(`snapshot on the diagram (${t.dialect})`, () => {
    test('lays what changed since a snapshot over the designer, drawing what is gone', async ({ page }) => {
      test.setTimeout(90_000)
      await login(page, t)
      const scratch = `e2e_snapdia_${Date.now().toString(36)}`
      // A database of its own on MySQL, a schema of the shared database on PostgreSQL: the fixtures stay as they are.
      const mysql = t.dialect === 'mysql'
      const db = mysql ? scratch : t.database
      const schema = mysql ? undefined : scratch
      if (mysql) await sql(page, t, `CREATE DATABASE ${scratch}`)
      else await sql(page, t, `CREATE SCHEMA ${scratch}`)
      const run = (statement: string) => sql(page, t, statement, db, schema)
      const q = schema ? `?schema=${schema}` : ''
      try {
        await run('CREATE TABLE owners (id INT PRIMARY KEY)')
        await run('CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))')
        await run('CREATE TABLE items (id INT PRIMARY KEY)')
        await page.goto(`/db/${db}/snapshots${q}`)
        await page.getByLabel('名前', { exact: true }).fill('前')
        await page.getByRole('button', { name: 'スナップショットを取る' }).click()
        const list = page.getByRole('table', { name: '保存したスナップショット' })
        await expect(list.getByRole('cell', { name: '前', exact: true })).toBeVisible()

        // The "migration": pets is gone, items has a column more, later is new.
        await run('DROP TABLE pets; ALTER TABLE items ADD COLUMN note INT; CREATE TABLE later (id INT PRIMARY KEY)')
        await page.getByRole('button', { name: '前: 現在と比較' }).click()
        await page.getByRole('dialog').getByRole('button', { name: '図で見る' }).click()

        await expect(page.getByRole('region', { name: 'スナップショット「前」と比べています' })).toBeVisible()
        const box = (name: string) => page.getByRole('button', { name: new RegExp(`^テーブル ${name}`) })
        await expect(box('later')).toHaveAttribute('data-tone', 'index')
        await expect(box('items')).toHaveAttribute('data-tone', 'nullify')
        // Drawn again, though it is gone, with the key it had.
        await expect(box('pets')).toHaveAttribute('data-tone', 'blocked')
        await expect(page.locator('figure g[data-tone="blocked"] path')).not.toHaveCount(0)
        await expect(box('owners')).not.toHaveAttribute('data-tone')

        await page.getByRole('link', { name: '比べるのをやめる' }).click()
        await expect(box('pets')).toHaveCount(0)
      } finally {
        if (mysql) await sql(page, t, `DROP DATABASE IF EXISTS ${scratch}`)
        else await sql(page, t, `DROP SCHEMA IF EXISTS ${scratch} CASCADE`)
      }
    })
  })
}
