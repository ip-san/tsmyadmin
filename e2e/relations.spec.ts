import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`relations (${t.dialect})`, () => {
    test('adds a foreign key to a table in another database or schema', async ({ page }) => {
      await login(page, t)
      const table = `e2e_xfk_${Date.now().toString(36)}`
      // MySQL: tsmyadmin_other.marker (id INT); PostgreSQL: app.settings (key TEXT), another schema of this database.
      const [space, refTable, refColumn, type] =
        t.dialect === 'mysql' ? ['tsmyadmin_other', 'marker', 'id', 'INT'] : ['app', 'settings', 'key', 'TEXT']
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, ref ${type})`)
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByRole('button', { name: '外部キーを追加' }).click()
        const dialog = page.getByRole('dialog')
        await dialog
          .getByRole('group', { name: 'このテーブルのカラム' })
          .getByRole('checkbox', { name: 'ref', exact: true })
          .check()
        await dialog.getByLabel(t.dialect === 'mysql' ? '参照先のデータベース' : '参照先のスキーマ').selectOption(space)
        await dialog.getByLabel('参照先テーブル').selectOption(refTable)
        await dialog
          .getByRole('group', { name: '参照先カラム' })
          .getByRole('checkbox', { name: refColumn, exact: true })
          .check()
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, new RegExp(`REFERENCES [\`"]${space}[\`"]\\.[\`"]${refTable}[\`"]`))
        await expect(page.getByRole('table', { name: '外部キー' })).toContainText(refTable)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test("names a referenced row by the column chosen as its table's display column", async ({ page }) => {
      await login(page, t)
      await page.goto(tableUrl(t, 'users', '/structure'))
      await page.getByLabel('表示カラム').selectOption('email')
      await page.goto(tableUrl(t, 'posts'))
      await page.locator('summary', { hasText: '表示のしかた' }).click()
      await page.getByLabel('外部キーの参照先の名前を併記').check()
      await expect(page.getByRole('table', { name: 'posts' }).getByText('alice@example.com').first()).toBeVisible()
    })
  })
}
