import { expect } from '@playwright/test'
import { login, PERSISTENT_BASE_URL, TARGETS, test } from './helpers.ts'

// This server keeps sessions (and therefore bookmarks) in the encrypted SQLite store, as a production
// deployment does; the other specs run against the in-memory store, where the browser keeps its own list.
test.use({ baseURL: PERSISTENT_BASE_URL })

const t = TARGETS[0] as (typeof TARGETS)[number]

test.describe('saved queries on a persistent deployment', () => {
  test('are kept with the account rather than in the browser', async ({ page }) => {
    const name = `e2e ${Date.now()}`
    await login(page, t)
    await page.goto(`/db/${t.database}/sql`)
    const panel = page.locator('summary').filter({ hasText: '保存済みクエリ' })
    await panel.click()
    await expect(page.getByText('この接続ユーザーのアカウントに保存されます。', { exact: false })).toBeVisible()

    const entry = page.getByRole('listitem').filter({ hasText: name })
    let saved = false
    try {
      await page.getByLabel('クエリ名').fill(name)
      await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
      await page.keyboard.type('SELECT 1')
      await page.getByRole('button', { name: '保存する', exact: true }).click()
      await expect(entry).toBeVisible()
      saved = true

      // Nothing of it is in this browser: emptying local storage and reloading still shows it.
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await page.reload()
      await panel.click()
      await expect(entry).toBeVisible()
    } finally {
      // The list is shared by every run against this account, so the row goes even if an assertion failed.
      // Whether it exists is tracked, not re-read from the page: a failure that leaves the panel collapsed
      // would make the row invisible while it is still very much on the server. Cleanup never throws — a
      // failure here would replace the assertion error that actually explains the run.
      if (saved) {
        await (async () => {
          if (!(await entry.isVisible())) await panel.click()
          await entry.getByRole('button', { name: `${name} を削除` }).click()
          await expect(entry).toBeHidden()
        })().catch(() => undefined)
      }
    }
  })
})
