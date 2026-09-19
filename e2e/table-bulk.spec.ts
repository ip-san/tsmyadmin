import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`tables in bulk (${t.dialect})`, () => {
    test('shows CREATE statements, maintains, copies and renames the ticked tables by prefix', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const id = Date.now().toString(36)
      const [a, b] = [`e2ebk_${id}_a`, `e2ebk_${id}_b`]
      const other = t.dialect === 'mysql' ? 'tsmyadmin_other' : 'app'
      for (const x of [a, b]) await sql(page, t, `CREATE TABLE ${x} (id INT PRIMARY KEY)`)
      try {
        await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
        for (const x of [a, b])
          await page
            .getByRole('row', { name: new RegExp(x) })
            .getByRole('checkbox')
            .check()

        await page.getByRole('button', { name: 'CREATE 文を表示' }).click()
        await expect(page.getByRole('dialog').getByLabel('CREATE 文を表示')).toContainText(b)
        await page.keyboard.press('Escape')

        await page.getByLabel('メンテナンス…').selectOption('analyze')
        await confirmPreview(page, /ANALYZE/)

        for (const x of [a, b])
          await page
            .getByRole('row', { name: new RegExp(x) })
            .getByRole('checkbox')
            .check()
        await page.getByRole('button', { name: '別の場所へコピー…' }).click()
        await page
          .getByRole('dialog')
          .getByLabel(t.dialect === 'mysql' ? 'コピー先のデータベース' : 'コピー先のスキーマ')
          .selectOption(other)
        await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /CREATE TABLE/)

        for (const x of [a, b])
          await page
            .getByRole('row', { name: new RegExp(x) })
            .getByRole('checkbox')
            .check()
        await page.getByRole('button', { name: '接頭辞を置換…' }).click()
        await page.getByRole('dialog').getByLabel('置き換える接頭辞').fill(`e2ebk_${id}_`)
        await page.getByRole('dialog').getByLabel('新しい接頭辞').fill(`e2ebk_${id}_x_`)
        await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /RENAME/)
        await expect(page.getByRole('link', { name: `e2ebk_${id}_x_a`, exact: true }).first()).toBeVisible()
      } finally {
        for (const x of [a, b, `e2ebk_${id}_x_a`, `e2ebk_${id}_x_b`]) await sql(page, t, `DROP TABLE IF EXISTS ${x}`)
        for (const x of [a, b]) await sql(page, t, `DROP TABLE IF EXISTS ${other}.${x}`)
      }
    })
  })
}
