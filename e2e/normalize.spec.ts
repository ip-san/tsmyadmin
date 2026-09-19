import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`normalization hints (${t.dialect})`, () => {
    test('points at numbered columns and a reference without a foreign key', async ({ page }) => {
      await login(page, t)
      const table = `e2e_norm_${Date.now().toString(36)}`
      await sql(
        page,
        t,
        `CREATE TABLE ${table} (id INT PRIMARY KEY, user_id INT, phone1 VARCHAR(20), phone2 VARCHAR(20))`
      )
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByText('正規化の手がかり').click()
        const hints = page.getByRole('list', { name: '正規化の手がかり' })
        await expect(hints.getByRole('listitem')).toHaveCount(2)
        await expect(hints).toContainText('phone1, phone2 は同じ種類の値を番号付きで並べています')
        await expect(hints).toContainText('user_id は users を指しているように見えますが')
        await expect(page.getByText(/行が 0 行しかないため/)).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
