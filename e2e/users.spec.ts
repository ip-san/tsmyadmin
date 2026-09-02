import { expect, test } from '@playwright/test'
import { confirmPreview, login, TARGETS } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`users (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('creates a user, grants database privileges, changes the password and drops it', async ({ page }) => {
      const name = `e2e_user_${Date.now().toString(36)}`
      await page.goto('/users')
      await expect(page.getByRole('cell', { name: 'tsmyadmin', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'ユーザーを作成' }).click()
      await page.getByLabel('ユーザー名').fill(name)
      await page.getByLabel('パスワード', { exact: true }).fill('pw-123')
      await page.getByLabel('パスワード（確認）').fill('pw-123')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await expect(page.getByRole('dialog').getByLabel('SQL')).toContainText('****')
      await expect(page.getByRole('dialog').getByLabel('SQL')).not.toContainText('pw-123')
      await confirmPreview(page, /CREATE (USER|ROLE)/)
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()

      const key = t.dialect === 'mysql' ? `${name}@%` : name
      await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
      await expect(page.getByLabel(`${key}: 権限`, { exact: true })).toBeVisible()

      await page.goto(t.schema ? `/db/${t.database}/privileges?schema=${t.schema}` : `/db/${t.database}/privileges`)
      const privRow = page.getByRole('row').filter({ hasText: name })
      // A fresh PostgreSQL role already has PUBLIC's USAGE on the public schema.
      await expect(privRow.getByText(t.dialect === 'mysql' ? 'なし' : '一部', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: `${key}: このデータベースの全権限を付与` }).click()
      await confirmPreview(page, /GRANT/)
      await expect(page.getByText(/「全権限を付与」を実行しました/)).toBeVisible()
      // Current-privilege column reflects the grant (MySQL: ALL on the database; PostgreSQL: schema grants).
      await expect(privRow.getByText('すべて', { exact: true })).toBeVisible()

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
      // MySQL grants are per database; PostgreSQL grants are per schema.
      await expect(page.getByLabel(`${key}: 権限`, { exact: true })).toContainText(
        t.dialect === 'mysql' ? t.database.replaceAll('_', '\\_') : (t.schema ?? 'public')
      )

      await page.getByRole('button', { name: `${key}: パスワードを変更` }).click()
      await page.getByLabel('パスワード', { exact: true }).fill('new-pw')
      await page.getByLabel('パスワード（確認）').fill('new-pw')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ALTER (USER|ROLE)/)

      await page.goto(t.schema ? `/db/${t.database}/privileges?schema=${t.schema}` : `/db/${t.database}/privileges`)
      await page.getByRole('button', { name: `${key}: このデータベースの全権限を取り消す` }).click()
      await confirmPreview(page, /REVOKE/)

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 削除` }).click()
      await confirmPreview(page, /DROP (USER|ROLE)/, name)
      await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
    })
  })
}
