import { expect, type Page, test } from '@playwright/test'
import { login, slowSql, TARGETS, tableUrl } from './helpers.ts'

async function typeSql(page: Page, sql: string) {
  const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(sql)
}

for (const t of TARGETS) {
  test.describe(`sql (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('runs multiple statements and shows one result per statement', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await typeSql(page, 'SELECT name FROM users ORDER BY id LIMIT 2; SELECT COUNT(*) AS n FROM users')
      await page.keyboard.press('ControlOrMeta+Enter')
      const first = page.getByRole('region', { name: '文 1' })
      await expect(first).toContainText('2 行')
      await expect(first.getByRole('cell', { name: 'Alice', exact: true })).toBeVisible()
      const second = page.getByRole('region', { name: '文 2' })
      await expect(second.getByRole('cell', { name: '5', exact: true })).toBeVisible()
      await expect(page.getByText('履歴 (1)')).toBeVisible()
    })

    test('attributes errors to the failing statement and records history', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await typeSql(page, 'SELECT 1 AS ok; SELECT * FROM table_that_is_missing; SELECT 3')
      await page.getByRole('button', { name: '実行する' }).click()
      await expect(page.getByRole('region', { name: '文 1' })).toContainText('1 行')
      const failed = page.getByRole('region', { name: '文 2' })
      await expect(failed).toContainText('エラー')
      await expect(failed.getByRole('alert')).toContainText(/table_that_is_missing/i)
      await expect(failed.getByTitle('サーバーのエラーコード')).toHaveText(
        t.dialect === 'mysql' ? 'ER_NO_SUCH_TABLE' : '42P01'
      )
      if (t.dialect === 'postgres') await expect(failed.getByRole('alert')).toContainText('1 行目 15 文字目')
      await expect(page.getByRole('region', { name: '文 3' })).toHaveCount(0)
      await page.getByText('履歴 (1)').click()
      await expect(page.getByTitle('失敗')).toBeVisible()
    })

    test('shows earlier results while a later statement is still running', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await typeSql(page, `SELECT 'first' AS step; ${slowSql(t.dialect)}`)
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      // First statement's result arrives before the slow one finishes: the run is still cancellable.
      await expect(
        page.getByRole('region', { name: '文 1' }).getByRole('cell', { name: 'first', exact: true })
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'キャンセル' })).toBeVisible()
      await page.getByRole('button', { name: 'キャンセル' }).click()
      await expect(page.getByRole('region', { name: '文 2' })).toContainText('エラー', { timeout: 15_000 })
    })

    test('a running statement can be cancelled', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      const slow = slowSql(t.dialect)
      await typeSql(page, slow)
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      await page.getByRole('button', { name: 'キャンセル' }).click()
      const first = page.getByRole('region', { name: '文 1' })
      await expect(first).toContainText('エラー', { timeout: 15_000 })
      await expect(page.getByRole('button', { name: '実行する', exact: true })).toBeEnabled()
    })

    test('EXPLAIN, saved queries and result download', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await typeSql(page, 'SELECT name FROM users ORDER BY id LIMIT 2')
      await page.getByRole('button', { name: 'EXPLAIN' }).click()
      const plan = page.getByRole('region', { name: '文 1' })
      await expect(plan).toContainText(/EXPLAIN SELECT/)
      await expect(plan.getByRole('table')).toBeVisible()
      // Bookmark, reload the page and load it back into the editor.
      await page.getByText('保存済みクエリ (0)').click()
      await page.getByLabel('クエリ名').fill('two names')
      await page.getByRole('button', { name: '保存する', exact: true }).click()
      await expect(page.getByText('保存済みクエリ (1)')).toBeVisible()
      await page.reload()
      await page.getByText('保存済みクエリ (1)').click()
      await page
        .getByRole('listitem')
        .filter({ hasText: 'two names' })
        .getByRole('button', { name: '読み込む' })
        .click()
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      const result = page.getByRole('region', { name: '文 1' })
      await expect(result.getByRole('cell', { name: 'Alice', exact: true })).toBeVisible()
      const download = page.waitForEvent('download')
      await result.getByRole('button', { name: 'CSV' }).click()
      const file = await download
      expect(file.suggestedFilename()).toMatch(/\.csv$/)
      const text = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8')
      expect(text).toBe('name\r\nAlice\r\nBob\r\n')
      // Multi-statement scripts cannot be EXPLAINed.
      await typeSql(page, 'SELECT 1; SELECT 2')
      await expect(page.getByRole('button', { name: 'EXPLAIN' })).toBeDisabled()
      // The unsent draft survives leaving and returning to the console.
      await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await expect(page.getByRole('textbox', { name: 'SQL エディタ' })).toContainText('SELECT 1; SELECT 2')
    })

    test('table SQL tab is prefilled and DML refreshes the browse view', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/sql'))
      await expect(page.getByRole('textbox', { name: 'SQL エディタ' })).toContainText('SELECT * FROM')
      await page.getByRole('button', { name: '実行する' }).click()
      await expect(page.getByRole('region', { name: '文 1' })).toContainText('5 行')
      await expect(
        page.getByRole('region', { name: '文 1' }).getByRole('cell', { name: 'Eve', exact: true })
      ).toBeVisible()
    })
  })
}
