import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`search operators and options (${t.dialect})`, () => {
    test('IN with chosen columns and order in the browse tab; DISTINCT opens a SELECT in the SQL tab', async ({
      page,
    }) => {
      await login(page, t)
      const table = `e2e_srch_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, grp VARCHAR(10), n INT)`)
      await sql(page, t, `INSERT INTO ${table} VALUES (1, 'a', 10), (2, 'b', 20), (3, 'a', 30), (4, 'c', 40)`)
      try {
        await page.goto(tableUrl(t, table, '/search'))
        await page.getByLabel('id: 条件').selectOption('in')
        await page.getByLabel('id: 値').fill('1, 3, 4')
        await page.getByText(/^オプション/).click()
        await page.getByRole('checkbox', { name: 'grp', exact: true }).uncheck()
        await page.getByLabel('並べ替え', { exact: true }).selectOption('n')
        await page.getByLabel('並べ替え: n').selectOption('desc')
        await page.getByRole('button', { name: '検索する' }).click()

        await expect(page.getByText('全 3 行')).toBeVisible()
        const grid = page.getByRole('table', { name: table })
        await expect(grid.getByRole('columnheader', { name: /grp/ })).toHaveCount(0)
        await expect(grid.getByRole('row').nth(1)).toContainText('40')
        await expect(page.getByText(/id IN（いずれか） 1, 3, 4/)).toBeVisible()

        // DISTINCT: a SELECT of its own, in the SQL tab.
        await page.goto(tableUrl(t, table, '/search'))
        await page.getByText(/^オプション/).click()
        for (const c of ['id', 'n']) await page.getByRole('checkbox', { name: c, exact: true }).uncheck()
        await page.getByLabel('重複する行を 1 つにまとめる（DISTINCT）').check()
        await page.getByRole('button', { name: '検索する' }).click()
        const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
        await expect(editor).toContainText(/SELECT DISTINCT \S*grp/)
        await page.getByRole('button', { name: '実行する', exact: true }).click()
        await expect(page.getByText(/3 行/).first()).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('replaces by regular expression', async ({ page }) => {
      await login(page, t)
      const table = `e2e_rrx_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(40))`)
      await sql(page, t, `INSERT INTO ${table} (id, name) VALUES (1, 'a1b22c333'), (2, 'none')`)
      try {
        await page.goto(tableUrl(t, table, '/search'))
        await page.getByLabel('カラム', { exact: true }).selectOption('name')
        await page.getByLabel('探す文字列').fill('[0-9]+')
        await page.getByLabel('置き換える文字列').fill('#')
        await page.getByLabel('正規表現として扱う').check()
        await page.getByRole('button', { name: 'SQL を確認' }).click()
        await confirmPreview(page, /regexp_replace/i)
        const rows = await sql(page, t, `SELECT name FROM ${table} ORDER BY id`)
        expect(rows[0].result.rows).toEqual([['a#b#c#'], ['none']])
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
