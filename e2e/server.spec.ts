import { expect, test } from '@playwright/test'
import { login, TARGETS } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`server (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('status, variables and processes tabs', async ({ page }) => {
      await page.goto('/status')
      await expect(page.getByText('バージョン')).toBeVisible()
      await expect(page.getByRole('definition').first()).toContainText(/\d+\./)
      await expect(page.getByRole('table', { name: 'ステータス変数' })).toBeVisible()

      await page.goto('/variables')
      await page.getByLabel('名前で絞り込む').fill('max_connections')
      const vars = page.getByRole('table', { name: 'システム変数' })
      // MySQL also has mysqlx_max_connections; PostgreSQL has just one match — and nothing else is listed.
      await expect(vars).toContainText('max_connections')
      await expect(vars).not.toContainText(t.dialect === 'mysql' ? 'version_comment' : 'work_mem')
      await expect(vars.getByRole('row')).toHaveCount(t.dialect === 'mysql' ? 3 : 2)

      await page.goto('/processes')
      const procs = page.getByRole('table', { name: 'プロセス一覧' })
      await expect(procs.getByRole('row').filter({ hasText: 'tsmyadmin' }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: /: 強制終了$/ }).first()).toBeVisible()
    })
  })
}
