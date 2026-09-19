import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`table list (${t.dialect})`, () => {
    test('counts a table exactly on request, and shows MySQL collation and times', async ({ page }) => {
      await login(page, t)
      await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
      const count = page.getByRole('button', { name: 'users の行数を正確に数える' })
      await count.click()
      await expect(page.getByTitle('正確に数えた行数です')).toHaveText('5')
      if (t.dialect === 'mysql') {
        await expect(page.getByRole('columnheader', { name: '照合順序' })).toBeVisible()
        await expect(page.getByRole('row').filter({ has: page.getByTitle('正確に数えた行数です') })).toContainText(
          /utf8mb4_/
        )
      }
    })
  })
}
