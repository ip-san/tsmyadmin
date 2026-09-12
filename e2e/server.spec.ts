import { expect } from '@playwright/test'
import { login, slowSql, TARGETS, test } from './helpers.ts'

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
      // Ending just the statement is offered next to it, and needs no confirmation.
      await expect(page.getByRole('button', { name: /: 実行中のクエリを中断$/ }).first()).toBeVisible()
    })

    test('cancels a running query without dropping the connection', async ({ page, browser }) => {
      // A second session runs something slow; this one stops its statement from the processes tab.
      const other = await browser.newContext()
      const victim = await other.newPage()
      await login(victim, t)
      await victim.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      const editor = victim.getByRole('textbox', { name: 'SQL エディタ' })
      await editor.click()
      await victim.keyboard.type(`/* e2e_cancel */ ${slowSql(t.dialect)}`)
      await victim.getByRole('button', { name: '実行する', exact: true }).click()

      try {
        await page.goto('/processes')
        const procs = page.getByRole('table', { name: 'プロセス一覧' })
        // Matched by a marker in the SQL itself: `hasText` is case-insensitive, so 'SLEEP' would also match
        // MySQL's idle connections, whose Command column reads "Sleep".
        const row = procs.getByRole('row').filter({ hasText: 'e2e_cancel' })
        await expect(row.first()).toBeVisible({ timeout: 15_000 })
        await row
          .first()
          .getByRole('button', { name: /: 実行中のクエリを中断$/ })
          .click()
        await expect(page.getByText(/実行中のクエリを中断しました/)).toBeVisible()
        // The connection survives: its row is still listed after the statement ends.
        await expect(procs.getByRole('row').filter({ hasText: 'tsmyadmin' }).first()).toBeVisible()
      } finally {
        await other.close()
      }
    })
  })
}
