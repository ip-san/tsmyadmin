import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`data dictionary (${t.dialect})`, () => {
    test('lists every table with its columns and what they reference', async ({ page }) => {
      await login(page, t)
      await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
      await page.getByRole('link', { name: 'データ辞書（全テーブルの定義を印刷用に）' }).click()
      const posts = page.getByRole('table', { name: 'posts', exact: true })
      await expect(posts.getByRole('row').filter({ hasText: 'user_id' })).toContainText('users.id')
      await expect(page.getByRole('table', { name: 'users', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '印刷' })).toBeVisible()
    })
  })
}
