import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, test } from './helpers.ts'

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

      // Per-table privileges: SELECT on one table only.
      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      const chooser = page.getByRole('dialog')
      await chooser.getByLabel('INSERT').check()
      await chooser.getByLabel('対象').selectOption('users')
      await chooser.getByRole('button', { name: '権限を付与' }).click()
      await confirmPreview(page, /GRANT SELECT, INSERT ON/)
      await expect(page.getByText(/「権限を付与」を実行しました/)).toBeVisible()

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
      // The grant names that one table.
      await expect(page.getByLabel(`${key}: 権限`, { exact: true })).toContainText('users')

      await page.goto(t.schema ? `/db/${t.database}/privileges?schema=${t.schema}` : `/db/${t.database}/privileges`)
      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      await page.getByRole('dialog').getByLabel('INSERT').check()
      await page.getByRole('dialog').getByLabel('対象').selectOption('users')
      await page.getByRole('dialog').getByRole('button', { name: '権限を取り消す' }).click()
      await confirmPreview(page, /REVOKE SELECT, INSERT ON/)

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
      // MySQL grants are per database; PostgreSQL grants are per schema.
      await expect(page.getByLabel(`${key}: 権限`, { exact: true })).toContainText(
        t.dialect === 'mysql' ? t.database.replaceAll('_', '\\_') : (t.schema ?? 'public')
      )

      // Column-level: SELECT on one column of one table.
      await page.goto(t.schema ? `/db/${t.database}/privileges?schema=${t.schema}` : `/db/${t.database}/privileges`)
      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      const columns = page.getByRole('dialog')
      await columns.getByLabel('対象').selectOption('users')
      await columns.getByRole('checkbox', { name: 'name', exact: true }).check()
      // DELETE has no column form, so the form says so and refuses to submit rather than failing at execute.
      await columns.getByRole('checkbox', { name: /^DELETE/ }).check()
      await expect(columns.getByText('テーブル単位のみです', { exact: false })).toBeVisible()
      await expect(columns.getByRole('button', { name: '権限を付与' })).toBeDisabled()
      await columns.getByRole('checkbox', { name: /^DELETE/ }).uncheck()

      await columns.getByRole('button', { name: '権限を付与' }).click()
      await confirmPreview(page, /GRANT SELECT \(.?name.?\) ON/)
      await expect(page.getByText(/「権限を付与」を実行しました/)).toBeVisible()

      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
      // Visible on both servers: MySQL reads it from SHOW GRANTS, PostgreSQL from pg_attribute.attacl.
      await expect(page.getByLabel(`${key}: 権限`, { exact: true })).toContainText(/SELECT \(.?name.?\)/)

      await page.goto(t.schema ? `/db/${t.database}/privileges?schema=${t.schema}` : `/db/${t.database}/privileges`)
      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      await page.getByRole('dialog').getByLabel('対象').selectOption('users')
      await page.getByRole('dialog').getByRole('checkbox', { name: 'name', exact: true }).check()
      await page.getByRole('dialog').getByRole('button', { name: '権限を取り消す' }).click()
      await confirmPreview(page, /REVOKE SELECT \(.?name.?\) ON/)

      await page.goto('/users')
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
