import { expect, type Page, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

async function confirmPreview(page: Page, expectSql: RegExp) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('SQL')).toContainText(expectSql)
  await dialog.getByRole('button', { name: '実行する' }).click()
  await expect(dialog).toBeHidden()
}

for (const t of TARGETS) {
  test.describe(`structure / ddl (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('creates, alters, indexes, truncates and drops a table through previews', async ({ page }) => {
      const table = `e2e_ddl_${Date.now().toString(36)}`
      const dbUrl = t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`

      // create table (id auto-increment PK + name)
      await page.goto(dbUrl)
      await page.getByLabel('テーブル名').fill(table)
      await page.getByLabel('カラム名 2').fill('name')
      await page.getByLabel('型 2').fill('VARCHAR(50)')
      await page.getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /CREATE TABLE/)
      await expect(page.getByRole('table').first().getByRole('link', { name: table, exact: true })).toBeVisible()

      // add column
      await page.goto(tableUrl(t, table, '/structure'))
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('カラム名').fill('n')
      await page.getByLabel('型', { exact: true }).fill('INT')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ADD COLUMN/)
      const columns = page.getByRole('table', { name: 'カラム' })
      await expect(columns.getByRole('row').filter({ hasText: /^3n/ })).toBeVisible()

      // modify column: rename n → n2, BIGINT NOT NULL
      await page.getByRole('button', { name: 'n: 変更' }).click()
      await page.getByLabel('カラム名').fill('n2')
      await page.getByLabel('型', { exact: true }).fill('BIGINT')
      await page.getByLabel('NULL を許可').uncheck()
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ALTER TABLE/)
      await expect(columns.getByRole('row').filter({ hasText: 'n2' })).toContainText(/bigint/i)
      await expect(columns.getByRole('row').filter({ hasText: 'n2' })).toContainText('いいえ')

      // add + drop index
      await page.getByRole('button', { name: 'インデックスを追加' }).click()
      await page.getByRole('dialog').getByLabel('name', { exact: true }).check()
      await page.getByRole('dialog').getByLabel('ユニーク').check()
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /CREATE UNIQUE INDEX/)
      const indexes = page.getByRole('table', { name: 'インデックス' })
      const idxName = `idx_${table}_name`
      await expect(indexes.getByRole('row').filter({ hasText: idxName })).toContainText('はい')
      await page.getByRole('button', { name: `${idxName}: 削除` }).click()
      await confirmPreview(page, /DROP INDEX/)
      await expect(indexes.getByRole('row').filter({ hasText: idxName })).toHaveCount(0)

      // drop column
      await page.getByRole('button', { name: 'n2: 削除' }).click()
      await confirmPreview(page, /DROP COLUMN/)
      await expect(columns.getByRole('row').filter({ hasText: 'n2' })).toHaveCount(0)

      // insert a row, truncate, then drop
      await page.goto(tableUrl(t, table, '/insert'))
      await page.getByLabel('name: NULL').uncheck()
      await page.getByLabel('name', { exact: true }).fill('x')
      await page.getByRole('button', { name: '挿入する' }).click()
      await expect(page.getByText('全 1 件')).toBeVisible()
      await page.goto(tableUrl(t, table, '/operations'))
      await page.getByRole('button', { name: 'テーブルを空にする' }).click()
      await confirmPreview(page, /TRUNCATE TABLE/)
      await page.goto(tableUrl(t, table))
      await expect(page.getByText('全 0 件')).toBeVisible()
      await page.goto(tableUrl(t, table, '/operations'))
      await page.getByRole('button', { name: 'テーブルを削除' }).click()
      await confirmPreview(page, /DROP TABLE/)
      await expect(page).toHaveURL(new RegExp(`/db/${t.database}(\\?|$)`))
      await expect(page.getByRole('table').first().getByRole('link', { name: table, exact: true })).toHaveCount(0)
    })

    test('shows the server error inside the preview dialog and keeps it open', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/structure'))
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('カラム名').fill('id')
      await page.getByLabel('型', { exact: true }).fill('INT')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: '実行する' }).click()
      await expect(dialog.getByRole('alert')).toContainText('失敗した文')
      await dialog.getByRole('button', { name: 'キャンセル' }).click()
      await expect(dialog).toBeHidden()
    })
  })
}
