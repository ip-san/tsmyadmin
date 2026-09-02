import { expect, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`import (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('imports a SQL file, then a CSV into the created table', async ({ page }) => {
      const table = `e2e_imp_${Date.now().toString(36)}`
      const sql = `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(50) NULL);\nINSERT INTO ${table} (id, name) VALUES (1, 'from sql');\nSELECT * FROM nope_table_for_error;`
      await page.goto(t.schema ? `/db/${t.database}/import?schema=${t.schema}` : `/db/${t.database}/import`)
      await page
        .getByLabel('ファイル')
        .setInputFiles({ name: 'dump.sql', mimeType: 'text/plain', buffer: Buffer.from(sql) })
      await page.getByLabel('エラーで停止').uncheck()
      await page.getByRole('button', { name: 'インポートする' }).click()
      await expect(page.getByText('2 文成功、1 文失敗')).toBeVisible()
      await expect(page.getByRole('alert')).toContainText(/nope_table_for_error/i)

      await page.goto(tableUrl(t, table, '/import'))
      const csv = 'id,name\n2,"from, csv"\n3,\\N\n'
      await page
        .getByLabel('ファイル')
        .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      await page.getByRole('button', { name: 'インポートする' }).click()
      await expect(page.getByText(`${table} に 2 行を挿入しました`)).toBeVisible()

      await page.goto(tableUrl(t, table))
      await expect(page.getByText('全 3 行')).toBeVisible()
      await expect(page.getByRole('cell', { name: 'from, csv', exact: true })).toBeVisible()

      await page.request.post(`/api/databases/${t.database}/sql`, {
        data: { sql: `DROP TABLE ${table}`, ...(t.schema ? { schema: t.schema } : {}) },
      })
    })

    test('shows a validation error for a CSV header that does not match', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/import'))
      await page
        .getByLabel('ファイル')
        .setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('nope\n1\n') })
      await page.getByRole('button', { name: 'インポートする' }).click()
      await expect(page.getByRole('alert')).toContainText('nope')
    })
  })
}
