import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  await page.request
    .post(`/api/databases/${t.database}/sql`, { data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) } })
    .catch(() => undefined)
}

for (const t of TARGETS) {
  test.describe(`designer foreign key (${t.dialect})`, () => {
    test('adds a foreign key from the designer and draws it', async ({ page }) => {
      await login(page, t)
      const suffix = Date.now().toString(36)
      const parent = `e2e_dp_${suffix}`
      const child = `e2e_dc_${suffix}`
      await sql(page, t, `CREATE TABLE ${parent} (id INT PRIMARY KEY)`)
      await sql(page, t, `CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id INT)`)
      try {
        await page.goto(t.schema ? `/db/${t.database}/designer?schema=${t.schema}` : `/db/${t.database}/designer`)
        await page.getByRole('button', { name: '外部キーを追加' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('外部キーを付けるテーブル').selectOption(child)
        await dialog
          .getByRole('group', { name: 'このテーブルのカラム' })
          .getByRole('checkbox', { name: 'parent_id' })
          .check()
        await dialog.getByLabel('参照先テーブル').selectOption(parent)
        await dialog
          .getByRole('group', { name: '参照先カラム' })
          .getByRole('checkbox', { name: 'id', exact: true })
          .check()
        await dialog
          .getByRole('button', { name: /確認|SQL/ })
          .last()
          .click()
        await confirmPreview(page, /FOREIGN KEY/)
        // The list under the diagram (and the diagram) now carries it.
        await expect(
          page.getByRole('table', { name: '外部キー' }).getByRole('cell', { name: child, exact: true })
        ).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${child}`)
        await sql(page, t, `DROP TABLE IF EXISTS ${parent}`)
      }
    })
  })
}
