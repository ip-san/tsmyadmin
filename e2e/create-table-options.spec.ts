import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`creating a table with its options (${t.dialect})`, () => {
    test('writes the comment (and engine, collation on MySQL) into the CREATE TABLE', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const table = `e2e_copt_${Date.now().toString(36)}`
      const mysql = t.dialect === 'mysql'
      const drop = () =>
        page.request.post(`/api/databases/${t.database}/sql`, {
          data: {
            sql: `DROP TABLE IF EXISTS ${mysql ? `\`${table}\`` : `"${table}"`}`,
            ...(t.schema ? { schema: t.schema } : {}),
          },
        })
      try {
        await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
        await page.getByText('テーブルを作成').first().click()
        const form = page.getByRole('form', { name: 'テーブルを作成' })
        await form.getByLabel('テーブル名').fill(table)
        await form.getByLabel('コメント', { exact: true }).fill('made in the form')
        if (mysql) {
          await form.getByLabel('エンジン', { exact: true }).fill('InnoDB')
          await form.getByLabel('照合順序', { exact: true }).fill('utf8mb4_bin')
        }
        await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(
          page,
          mysql
            ? /ENGINE = InnoDB COLLATE = utf8mb4_bin COMMENT = 'made in the form'/
            : /COMMENT ON TABLE .* IS 'made in the form'/
        )
        await expect(page.getByRole('heading', { name: new RegExp(table) }).first()).toBeVisible()
      } finally {
        await drop().catch(() => undefined)
      }
    })
  })
}
