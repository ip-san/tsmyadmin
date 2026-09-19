import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`server top page (${t.dialect})`, () => {
    test('shows which server this is, and prints without its controls', async ({ page }) => {
      await login(page, t)
      await page.goto('/')
      const info = page.getByRole('region', { name: 'サーバー情報' })
      await expect(info).toContainText(`${t.host}:${t.port}`)
      await expect(info).toContainText('バージョン')
      if (t.dialect === 'mysql') await expect(info).toContainText('utf8mb4_unicode_ci')
      else await expect(info).not.toContainText('接続の照合順序')

      // On paper the checkboxes and the actions are left out, and so is the print button.
      await expect(page.getByRole('button', { name: '一覧を印刷' })).toBeVisible()
      await page.emulateMedia({ media: 'print' })
      await expect(page.getByRole('button', { name: '一覧を印刷' })).toBeHidden()
      await expect(page.getByLabel('すべて選択')).toBeHidden()
      await expect(page.getByRole('columnheader', { name: 'データベース名' })).toBeVisible()
    })

    test('connects in the collation chosen at login (MySQL only)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'the connection collation is a MySQL / MariaDB setting')
      await page.request.post('/api/session', {
        data: {
          dialect: t.dialect,
          host: t.host,
          port: t.port,
          user: t.user,
          password: t.password,
          database: t.database,
          collation: 'utf8mb4_bin',
        },
      })
      await page.goto('/')
      await expect(page.getByRole('region', { name: 'サーバー情報' })).toContainText('utf8mb4_bin')
    })
  })
}
