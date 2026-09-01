import { expect, test } from '@playwright/test'
import { login, TARGETS } from './helpers.ts'

async function confirmPreview(page: import('@playwright/test').Page, expectSql: RegExp) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('SQL')).toContainText(expectSql)
  await dialog.getByRole('button', { name: '実行する' }).click()
  await expect(dialog).toBeHidden()
}

for (const t of TARGETS) {
  test.describe(`users (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('creates a user, grants database privileges, changes the password and drops it', async ({ page }) => {
      const name = `e2e_user_${Date.now().toString(36)}`
      await page.goto('/users')
      await expect(page.getByRole('cell', { name: 'tsmyadmin', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'ユーザーを追加' }).click()
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
      await page.getByRole('button', { name: `${key}: この DB の全権限を付与` }).click()
      await confirmPreview(page, /GRANT/)

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
      // MySQL grants are per database; PostgreSQL grants are per schema.
      await expect(page.getByLabel(`${key}: 権限`, { exact: true })).toContainText(
        t.dialect === 'mysql' ? t.database : (t.schema ?? 'public')
      )

      await page.getByRole('button', { name: `${key}: パスワード変更` }).click()
      await page.getByLabel('パスワード', { exact: true }).fill('new-pw')
      await page.getByLabel('パスワード（確認）').fill('new-pw')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ALTER (USER|ROLE)/)

      await page.goto(t.schema ? `/db/${t.database}/privileges?schema=${t.schema}` : `/db/${t.database}/privileges`)
      await page.getByRole('button', { name: `${key}: この DB の権限を取り消す` }).click()
      await confirmPreview(page, /REVOKE/)

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 削除` }).click()
      await confirmPreview(page, /DROP (USER|ROLE)/)
      await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
    })
  })
}
