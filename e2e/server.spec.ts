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

      // Only what is doing something: no sleeping / idle connection is left, and this session's own statement is.
      await page.getByLabel('実行中のものだけ表示').check()
      await expect(procs.getByRole('cell', { name: /^(Sleep|idle)$/ })).toHaveCount(0)
      await expect(procs.getByRole('row').filter({ hasText: 'tsmyadmin' }).first()).toBeVisible()
      // The interval is a choice, not just on / off.
      await page.getByLabel('更新間隔').selectOption('2')
      await expect(page.getByLabel('更新間隔')).toHaveValue('2')
    })

    test('shows traffic and query statistics, filters status by category, and advises', async ({ page }) => {
      await page.goto('/status')
      await expect(page.getByRole('table', { name: '通信量と接続' })).toContainText(
        t.dialect === 'mysql' ? '接続数' : 'トランザクション数'
      )
      await expect(page.getByRole('table', { name: 'クエリ統計' })).toBeVisible()
      const status = page.getByRole('table', { name: 'ステータス変数' })
      if (t.dialect === 'mysql') {
        await page.getByLabel('カテゴリ').selectOption('Com')
        await expect(status.getByRole('cell', { name: /^Com_/ }).first()).toBeVisible()
        await expect(status.getByRole('cell', { name: /^Threads_/ })).toHaveCount(0)
      } else {
        await expect(page.getByLabel('カテゴリ')).toHaveCount(0)
      }
      await page.getByRole('link', { name: 'アドバイザー', exact: true }).click()
      await expect(page).toHaveURL(/\/advisor$/)
      // Whatever this server's counters say, the page answers with a list of advice or that there is none.
      await expect(
        page.getByRole('list', { name: 'アドバイザー' }).or(page.getByText('目立つ点は見つかりませんでした。'))
      ).toBeVisible()
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
