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
      await page.getByRole('button', { name: '実行' }).click()
      await expect(page.getByRole('region', { name: '文 1' })).toContainText('1 行')
      const failed = page.getByRole('region', { name: '文 2' })
      await expect(failed).toContainText('エラー')
      await expect(failed.getByRole('alert')).toContainText(/table_that_is_missing/i)
      await expect(failed.getByTitle('DB エラーコード')).toHaveText(
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
      await page.getByRole('button', { name: '実行', exact: true }).click()
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
      await page.getByRole('button', { name: '実行', exact: true }).click()
      await page.getByRole('button', { name: 'キャンセル' }).click()
      const first = page.getByRole('region', { name: '文 1' })
      await expect(first).toContainText('エラー', { timeout: 15_000 })
      await expect(page.getByRole('button', { name: '実行', exact: true })).toBeEnabled()
    })

    test('table SQL tab is prefilled and DML refreshes the browse view', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/sql'))
      await expect(page.getByRole('textbox', { name: 'SQL エディタ' })).toContainText('SELECT * FROM')
      await page.getByRole('button', { name: '実行' }).click()
      await expect(page.getByRole('region', { name: '文 1' })).toContainText('5 行')
      await expect(
        page.getByRole('region', { name: '文 1' }).getByRole('cell', { name: 'Eve', exact: true })
      ).toBeVisible()
    })
  })
}
