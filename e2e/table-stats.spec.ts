import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`table statistics (${t.dialect})`, () => {
    test('shows the space a table uses and its row statistics under the structure', async ({ page }) => {
      await login(page, t)
      await page.goto(tableUrl(t, 'users', '/structure'))
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '容量と行の統計' }) })
      await expect(card.getByText('使用容量')).toBeVisible()
      await expect(card.getByRole('definition').first()).toContainText(/\d/)
      // What only one server keeps: MySQL's row format, PostgreSQL's dead rows.
      await expect(card.getByText(t.dialect === 'mysql' ? '行フォーマット' : '不要な行（VACUUM 待ち）')).toBeVisible()
      await expect(card.getByRole('button', { name: 'この構造を印刷' })).toBeVisible()
    })
  })
}
