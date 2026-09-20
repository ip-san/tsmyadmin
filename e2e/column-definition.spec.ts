import { expect, type Page } from '@playwright/test'
import { confirmPreview, fillType, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`column definition (${t.dialect})`, () => {
    test('adds a generated column with its key, and keeps it generated when changed', async ({ page }) => {
      await login(page, t)
      const table = `e2e_coldef_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, a INT, b INT, label VARCHAR(20))`)
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByRole('button', { name: 'カラムを追加' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('カラム名').fill('total')
        await fillType(dialog, 'INT')
        await dialog.getByLabel('生成カラム（式から値を計算する）').check()
        // A generated column has no default or auto-increment of its own.
        await expect(dialog.getByLabel('既定値', { exact: true })).toBeDisabled()
        await dialog.getByLabel('式', { exact: true }).fill('a + b')
        await dialog.getByLabel('保存', { exact: true }).selectOption('stored')
        await dialog.getByLabel('キー').selectOption('index')
        if (t.dialect === 'mysql') await dialog.getByLabel('位置（この後に）').selectOption('first')
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /GENERATED ALWAYS AS \(a \+ b\) STORED[\s\S]*CREATE INDEX/)
        await sql(page, t, `INSERT INTO ${table} (id, a, b) VALUES (1, 2, 3)`)
        const read = await sql(page, t, `SELECT total FROM ${table}`)
        expect(read[0].result.rows).toEqual([[5]])
        const columns = page.getByRole('table', { name: 'カラム' })
        if (t.dialect === 'mysql') await expect(columns.getByRole('row').nth(1)).toContainText('total')

        // Changing only its comment keeps it generated (MySQL rewrites the whole column).
        await page.getByRole('button', { name: 'total: 変更' }).click()
        await expect(dialog.getByLabel('式', { exact: true })).toHaveValue(/a.*\+.*b/)
        await dialog.getByLabel('コメント').fill('sum')
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(
          page,
          t.dialect === 'mysql' ? /MODIFY COLUMN `total` int GENERATED ALWAYS AS/ : /COMMENT ON COLUMN/
        )
        const again = await sql(page, t, `SELECT total FROM ${table}`)
        expect(again[0].result.rows).toEqual([[5]])

        // A collation chosen for a text column is written with it.
        const collation = t.dialect === 'mysql' ? 'utf8mb4_bin' : 'C'
        await page.getByRole('button', { name: 'label: 変更' }).click()
        await dialog.getByLabel('照合順序').fill(collation)
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, new RegExp(`COLLATE "?${collation}"?`))
        await expect(columns.getByRole('row').filter({ hasText: 'label' })).toContainText(collation)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
