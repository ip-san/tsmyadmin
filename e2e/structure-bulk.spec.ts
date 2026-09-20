import { expect, type Page } from '@playwright/test'
import { confirmPreview, fillType, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`structure in bulk (${t.dialect})`, () => {
    test('indexes by kind, method and length; rename and change; columns together', async ({ page }) => {
      await login(page, t)
      const table = `e2e_bulk_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, a VARCHAR(40), b INT, c INT)`)
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        const columns = page.getByRole('table', { name: 'カラム' })
        await expect(columns).toBeVisible()

        // Tick a and b, then an index on them from the bar under the list.
        await page.getByLabel('a: 選ぶ').check()
        await page.getByLabel('b: 選ぶ').check()
        await page.getByRole('button', { name: 'インデックス', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('checkbox', { name: 'a' })).toBeChecked()
        await dialog.getByLabel('インデックス名').fill(`${table}_ab`)
        if (t.dialect === 'mysql') await dialog.getByLabel('a', { exact: true }).last().fill('5')
        else await dialog.getByLabel('方式').selectOption('btree')
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /\(`a`\(5\), `b`\)/ : /USING btree/)
        const indexes = page.getByRole('table', { name: 'インデックス' })
        await expect(indexes.getByRole('row', { name: new RegExp(`${table}_ab`) })).toBeVisible()

        // Rename it, then change it to a unique index on a alone.
        await page.getByRole('button', { name: `インデックス ${table}_ab: 名前を変更` }).click()
        await dialog.getByLabel('新しい名前').fill(`${table}_x`)
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /RENAME/)
        await page.getByRole('button', { name: `インデックス ${table}_x: 変更` }).click()
        await dialog.getByRole('checkbox', { name: 'b' }).uncheck()
        await dialog.getByLabel('種類').selectOption('unique')
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /UNIQUE INDEX/)
        await expect(indexes.getByRole('row', { name: new RegExp(`${table}_x`) })).toContainText('はい')

        // Two columns changed in one go, then both dropped together.
        await page.getByLabel('b: 選ぶ').check()
        await page.getByLabel('c: 選ぶ').check()
        await page.getByRole('button', { name: 'まとめて変更…' }).click()
        await expect(page.getByRole('dialog', { name: 'カラムを変更（1 / 2）' })).toBeVisible()
        await fillType(dialog, 'BIGINT')
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await expect(page.getByRole('dialog', { name: 'カラムを変更（2 / 2）' })).toBeVisible()
        await fillType(dialog, 'BIGINT')
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /BIGINT[\s\S]*BIGINT/i)
        await expect(columns.getByRole('row').filter({ hasText: /bigint/i })).toHaveCount(2)

        if (t.dialect === 'mysql') {
          // Reorder: c first.
          await page.getByRole('button', { name: 'カラムを並べ替え…' }).click()
          for (let i = 0; i < 3; i++) await dialog.getByRole('button', { name: 'c を上へ' }).click()
          await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
          await confirmPreview(page, /MODIFY COLUMN `c` bigint[\s\S]*FIRST/)
          await expect(columns.getByRole('row').nth(1)).toContainText('c')
        }

        await page.getByLabel('b: 選ぶ').check()
        await page.getByLabel('c: 選ぶ').check()
        await page.getByRole('button', { name: 'まとめて削除…' }).click()
        // In table order: after the reorder on MySQL, c comes before b.
        await confirmPreview(page, /DROP COLUMN [`"][bc][`"], DROP COLUMN [`"][bc][`"]/)
        await expect(columns.getByRole('row')).toHaveCount(3)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
