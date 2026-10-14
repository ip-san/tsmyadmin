import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, slowSql, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`server (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('status, variables and processes tabs', async ({ page }) => {
      await page.goto('/status')
      await expect(page.getByText('バージョン')).toBeVisible()
      await expect(page.getByText('起動日時')).toBeVisible()
      await expect(page.getByRole('definition').first()).toContainText(/\d+\./)
      await expect(page.getByRole('table', { name: 'ステータス変数' })).toBeVisible()

      await page.goto('/variables')
      await page.getByLabel('名前で絞り込む').fill('max_connections')
      const vars = page.getByRole('table', { name: 'システム変数' })
      // MySQL also has mysqlx_max_connections; PostgreSQL has just one match — and nothing else is listed.
      await expect(vars).toContainText('max_connections')
      await expect(vars).not.toContainText(t.dialect === 'mysql' ? 'version_comment' : 'work_mem')
      await expect(vars.getByRole('row')).toHaveCount(t.dialect === 'mysql' ? 3 : 2)
      // Each variable links to its manual page, in a new tab and without handing the page to the vendor's site.
      const manual = vars.getByRole('link', { name: 'max_connections: マニュアル', exact: true })
      await expect(manual).toHaveAttribute('target', '_blank')
      await expect(manual).toHaveAttribute('rel', /noopener/)
      await expect(manual).toHaveAttribute(
        'href',
        t.dialect === 'mysql'
          ? /(dev\.mysql\.com|mariadb\.com)\/.*max_connections/
          : /postgresql\.org\/search\/.*max_connections/
      )

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

      // A column sorts the list (click: ascending, again: descending, again: as the server sent it).
      const idHeader = procs.getByRole('columnheader', { name: /^(プロセス ID|ID)/ })
      await idHeader.getByRole('button').click()
      await expect(idHeader).toHaveAttribute('aria-sort', 'ascending')
      await idHeader.getByRole('button').click()
      await expect(idHeader).toHaveAttribute('aria-sort', 'descending')
      await idHeader.getByRole('button').click()
      await expect(idHeader).toHaveAttribute('aria-sort', 'none')
      // Long statements are cut unless the whole text is asked for.
      await page.getByLabel(/クエリの全文を表示/).check()
      await expect(page.getByLabel(/クエリの全文を表示/)).toBeChecked()
    })

    test('changes a server setting through the preview, and puts it back to its default', async ({ page }) => {
      test.setTimeout(60_000)
      const name = t.dialect === 'mysql' ? 'long_query_time' : 'work_mem'
      const value = t.dialect === 'mysql' ? '9' : '9MB'
      const rows = page.getByRole('table', { name: 'システム変数' })
      const change = async () => {
        await page.goto('/variables')
        await page.getByLabel('名前で絞り込む').fill(name)
        await rows.getByRole('button', { name: `${name}: 変更`, exact: true }).click()
      }
      try {
        await change()
        await page.getByLabel(name, { exact: true }).fill(value)
        await page
          .getByRole('form', { name: `${name}: 変更` })
          .getByRole('button', { name: 'SQL を確認' })
          .click()
        await confirmPreview(
          page,
          t.dialect === 'mysql' ? new RegExp(`SET GLOBAL ${name} = 9`) : /ALTER SYSTEM SET work_mem = '9MB'/
        )
        await page.reload()
        await page.getByLabel('名前で絞り込む').fill(name)
        await expect(
          rows.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })
        ).toContainText(t.dialect === 'mysql' ? '9' : '9216')
      } finally {
        await change()
        await page.getByLabel('既定値に戻す').check()
        await page
          .getByRole('form', { name: `${name}: 変更` })
          .getByRole('button', { name: 'SQL を確認' })
          .click()
        await confirmPreview(page, t.dialect === 'mysql' ? /DEFAULT/ : /RESET work_mem/)
      }
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

    test('shows who holds the lock another session waits for, and ends the holder', async ({ page, browser }) => {
      test.setTimeout(60_000)
      const table = `e2e_lock_${Date.now().toString(36)}`
      const run = (p: Page, statement: string) =>
        p.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
        })
      await run(page, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
      await run(page, `INSERT INTO ${table} VALUES (1, 0)`)
      // Two more sessions: one keeps a row locked inside its transaction, the other waits for that row.
      const holderContext = await browser.newContext()
      const waiterContext = await browser.newContext()
      try {
        const holder = await holderContext.newPage()
        const waiter = await waiterContext.newPage()
        await login(holder, t)
        await login(waiter, t)
        const begin = t.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
        const sleep = t.dialect === 'mysql' ? 'SELECT SLEEP(20)' : 'SELECT pg_sleep(20)'
        const holding = run(holder, `${begin}; UPDATE ${table} SET v = 1 WHERE id = 1; ${sleep} /* e2e_lock_holder */`)
        await page.waitForTimeout(500)
        const timeout = t.dialect === 'mysql' ? 'SET SESSION innodb_lock_wait_timeout = 20' : "SET lock_timeout = '20s'"
        const waiting = run(waiter, `${timeout}; UPDATE ${table} SET v = 2 WHERE id = 1 /* e2e_lock_waiter */`)

        await page.goto('/processes')
        await page.getByLabel('更新間隔').selectOption('2')
        const waits = page.getByRole('table', { name: 'ロック待ち' })
        const row = waits.getByRole('row').filter({ hasText: 'e2e_lock_waiter' })
        await expect(row).toBeVisible({ timeout: 15_000 })
        await expect(row).toContainText('e2e_lock_holder')
        await expect(row).toContainText(table)
        await expect(page.getByText(/^接続数:/)).toBeVisible()

        // The holder is ended through the same confirmation as the process list's kill.
        await row.getByRole('button', { name: /: ブロック元を強制終了$/ }).click()
        await page.getByRole('dialog').getByRole('button', { name: '強制終了する' }).click()
        await expect(page.getByText(/を強制終了しました/)).toBeVisible()
        await expect(page.getByText('ロック待ちはありません')).toBeVisible({ timeout: 10_000 })
        await Promise.all([holding, waiting])
      } finally {
        await holderContext.close()
        await waiterContext.close()
        await run(page, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
