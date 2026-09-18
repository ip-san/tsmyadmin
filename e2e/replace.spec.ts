import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`find and replace (${t.dialect})`, () => {
    test('replaces a text in one column, in the rows that hold it', async ({ page }) => {
      await login(page, t)
      const table = `e2e_rep_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(40))`)
      await sql(page, t, `INSERT INTO ${table} (id, name) VALUES (1, 'Apple pie'), (2, 'apple tart')`)
      try {
        await page.goto(tableUrl(t, table, '/search'))
        await page.getByLabel('カラム', { exact: true }).selectOption('name')
        await page.getByLabel('探す文字列').fill('Apple')
        await page.getByLabel('置き換える文字列').fill('Pear')
        await page.getByRole('button', { name: 'SQL を確認' }).click()
        await expect(page.getByRole('dialog')).toContainText('元に戻せない')
        await confirmPreview(page, /UPDATE .* SET .* WHERE/)
        const rows = await sql(page, t, `SELECT name FROM ${table} ORDER BY id`)
        expect(rows[0].result.rows).toEqual([['Pear pie'], ['apple tart']])
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
