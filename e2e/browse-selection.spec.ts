import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`browse selection (${t.dialect})`, () => {
    test('edits the ticked rows together, downloads them, and charts the page', async ({ page }) => {
      await login(page, t)
      const table = `e2e_sel_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20), n INT)`)
      await sql(page, t, `INSERT INTO ${table} VALUES (1, 'a', 10), (2, 'b', 20), (3, 'c', 30)`)
      try {
        await page.goto(tableUrl(t, table))
        await page.getByText('全 3 行').waitFor()
        const grid = page.getByRole('table', { name: table })
        await grid.getByRole('row').nth(1).getByRole('checkbox').check()
        await grid.getByRole('row').nth(3).getByRole('checkbox').check()

        // Download what is ticked: rows 1 and 3 only.
        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: '選択行を CSV で' }).click()
        const csv = readFileSync(await (await download).path(), 'utf8')
        expect(csv.trim().split(/\r?\n/).slice(1)).toEqual(['1,a,10', '3,c,30'])

        // Edit both in one dialog; each row sends only what changed in it.
        await page.getByRole('button', { name: '選択行を編集' }).click()
        const dialog = page.getByRole('dialog', { name: '2 行を編集' })
        await dialog.getByLabel('name（1 行目）', { exact: true }).fill('A')
        await dialog.getByLabel('n（2 行目）', { exact: true }).fill('33')
        await dialog.getByRole('button', { name: '保存する' }).click()
        await expect(page.getByText('2 行を更新しました')).toBeVisible()
        const rows = await sql(page, t, `SELECT id, name, n FROM ${table} ORDER BY id`)
        expect(rows[0].result.rows).toEqual([
          [1, 'A', 10],
          [2, 'b', 20],
          [3, 'c', 33],
        ])

        // A chart of the page, without the SQL tab.
        await page.getByRole('button', { name: 'このページのグラフ' }).click()
        await expect(page.getByLabel('グラフの種類')).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('makes a view of a SELECT from its result in the SQL console', async ({ page }) => {
      await login(page, t)
      const view = `e2e_selv_${Date.now().toString(36)}`
      try {
        await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
        const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
        await editor.click()
        await page.keyboard.type('SELECT id, name FROM users WHERE id < 3')
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: '実行する', exact: true }).click()
        await page.getByRole('link', { name: 'この SELECT からビューを作成' }).click()
        // The database page opens with the create-view form filled in.
        await expect(page.getByLabel('SELECT 文')).toHaveValue('SELECT id, name FROM users WHERE id < 3')
        await page.getByLabel('名前', { exact: true }).last().fill(view)
        await page.getByRole('button', { name: /ビューを作成: SQL を確認/ }).click()
        await confirmPreview(page, /CREATE VIEW/)
        const read = await sql(page, t, `SELECT COUNT(*) FROM ${view}`)
        expect(Number(read[0].result.rows[0][0])).toBe(2)
      } finally {
        await sql(page, t, `DROP VIEW IF EXISTS ${view}`)
      }
    })
  })
}
