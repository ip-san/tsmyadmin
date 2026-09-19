import { expect } from '@playwright/test'
import { login, PERSISTENT_BASE_URL, TARGETS, test } from './helpers.ts'

// The encrypted SQLite store: bookmarks shared with the server and the history follow the account, not the browser.
test.use({ baseURL: PERSISTENT_BASE_URL })

const t = TARGETS[0] as (typeof TARGETS)[number]

test.describe('shared bookmarks and history on a persistent deployment', () => {
  test('a shared bookmark fills in [DB], and the history is kept with the account and can be searched', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const name = `e2e shared ${Date.now()}`
    const marker = `e2e_marker_${Date.now().toString(36)}`
    await login(page, t)
    await page.goto(`/db/${t.database}/sql`)
    const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
    const shared = page.locator('summary').filter({ hasText: '共有のブックマーク' })
    const history = page.locator('summary').filter({ hasText: /^履歴/ })
    const entry = page.getByRole('listitem').filter({ hasText: name })
    let sharedSaved = false
    try {
      // A shared bookmark, written with a variable: loaded, it names the database it is loaded into.
      await editor.click()
      await page.keyboard.type(`SELECT '[DB]' AS ${marker}`)
      await shared.click()
      await expect(page.getByText('このサーバーのすべてのアカウントから見えます。', { exact: false })).toBeVisible()
      const sharedForm = page.locator('details').filter({ has: shared })
      await sharedForm.getByLabel('共有ブックマーク名').fill(name)
      await sharedForm.getByRole('button', { name: '共有する', exact: true }).click()
      await expect(entry).toBeVisible()
      sharedSaved = true

      // Run it, so it is in the history; then the browser forgets everything and the account still remembers.
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      await page.getByRole('region', { name: '文 1' }).waitFor()
      await expect(page.getByRole('region', { name: '文 1' })).toContainText(marker)
      await expect
        .poll(async () => (await (await page.request.get('/api/sql-history')).json()).entries.length)
        .toBeGreaterThan(0)
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await page.reload()
      await shared.click()
      await expect(entry).toBeVisible()
      await entry.getByRole('button', { name: '読み込む' }).click()
      await expect(editor).toContainText(`'${t.database}'`)
      await history.click()
      await expect(page.getByText('アカウントに保存されています')).toBeVisible()
      await page.getByLabel('履歴を絞り込む').fill(marker)
      await expect(page.getByText('1 件')).toBeVisible()
      await page.getByLabel('履歴を絞り込む').fill('no such statement')
      await expect(page.getByText('0 件')).toBeVisible()
    } finally {
      if (sharedSaved) {
        if (!(await entry.isVisible())) await shared.click()
        await entry.getByRole('button', { name: `${name} を削除` }).click()
        await expect(entry).toBeHidden()
      }
      await page.request.delete('/api/sql-history')
    }
  })

  test('after a statement runs: edit it, run it again, explain it, or turn it into code', async ({ page }) => {
    await login(page, t)
    await page.goto(`/db/${t.database}/sql`)
    await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
    await page.keyboard.type('SELECT 1 AS n')
    await page.getByRole('button', { name: '実行する', exact: true }).click()
    const statement = page.getByRole('region', { name: '文 1' })
    await statement.waitFor()

    await statement.getByRole('button', { name: '文 1 EXPLAIN' }).click()
    await expect(page.getByRole('region', { name: '文 1' })).toContainText('EXPLAIN SELECT 1 AS n')
    await page.getByRole('region', { name: '文 1' }).getByRole('button', { name: '文 1 再実行' }).click()
    await expect(page.getByRole('region', { name: '文 1' })).toContainText('EXPLAIN SELECT 1 AS n')

    await page.getByRole('region', { name: '文 1' }).getByRole('button', { name: '文 1 コードにする' }).click()
    const dialog = page.getByRole('dialog', { name: 'アプリケーション用のコード' })
    await expect(dialog).toContainText("$sql = 'EXPLAIN SELECT 1 AS n';")
    await dialog.getByLabel('言語').selectOption('javascript')
    await expect(dialog).toContainText('const sql = `EXPLAIN SELECT 1 AS n`;')
    await dialog.getByRole('button', { name: '閉じる' }).click()

    await page.getByRole('region', { name: '文 1' }).getByRole('button', { name: '文 1 編集' }).click()
    await expect(page.getByRole('textbox', { name: 'SQL エディタ' })).toContainText('EXPLAIN SELECT 1 AS n')
    await page.request.delete('/api/sql-history')
  })
})
