import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const designerUrl = `/db/${t.database}/designer${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`designer usage (${t.dialect})`, () => {
    test('lays how the tables are read over the diagram, with the indexes never read', async ({ page }) => {
      await login(page, t)
      // Read users once in full, so at least one table has counts whatever the other tests did.
      await page.request.post(`/api/databases/${t.database}/sql`, {
        data: { sql: 'SELECT COUNT(*) FROM users', ...(t.schema ? { schema: t.schema } : {}) },
      })
      await page.goto(designerUrl)
      await page.getByRole('checkbox', { name: '使われ方を重ねる' }).check()
      // Which way a table is mostly read is the server's (and the other tests'); that the overlay is drawn is not.
      await expect(page.getByText('全件で読まれることが多い')).toBeVisible()
      await expect(page.getByText(/からの(走査の回数|読んだ行数)です/)).toBeVisible()
      await expect(page.getByRole('heading', { name: '読まれていないインデックス' })).toBeVisible()
      await expect(page.locator('figure [data-tone]').first()).toBeVisible()
      await page.getByRole('checkbox', { name: '使われ方を重ねる' }).uncheck()
      await expect(page.getByText('全件で読まれることが多い')).toHaveCount(0)
    })
  })
}
