import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`proposing a narrower type (${t.dialect})`, () => {
    test('suggests INT for a VARCHAR column that holds only integers, and changes it through the preview', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const table = `e2e_prop_${Date.now().toString(36)}`
      const run = (sql: string) =>
        page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql, ...(t.schema ? { schema: t.schema } : {}) },
        })
      try {
        await run(`CREATE TABLE ${table} (id INT PRIMARY KEY, code VARCHAR(255), label VARCHAR(20))`)
        await run(`INSERT INTO ${table} VALUES (1, '10', 'a'), (2, '200', 'b'), (3, NULL, 'c')`)
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByRole('button', { name: '構造の提案' }).click()
        const proposals = page.getByRole('table', { name: '型の提案' })
        await expect(proposals.getByRole('row', { name: /code/ })).toContainText('INT')
        // The text column stays as it is: only what the values say is proposed.
        await expect(proposals.getByRole('row', { name: /label/ })).toHaveCount(0)
        await page.getByRole('button', { name: '選んだ提案を確認…' }).click()
        await confirmPreview(page, /code/)
        await expect(page.getByRole('table', { name: 'カラム' }).getByRole('row', { name: /code/ })).toContainText(
          /int/i
        )
      } finally {
        await run(`DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
