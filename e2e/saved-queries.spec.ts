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

    await page.getByLabel('クエリ名').fill(name)
    await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
    await page.keyboard.type('SELECT 1')
    await page.getByRole('button', { name: '保存する', exact: true }).click()
    const entry = page.getByRole('listitem').filter({ hasText: name })
    await expect(entry).toBeVisible()

    try {
      // Nothing of it is in this browser: emptying local storage and reloading still shows it.
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await page.reload()
      await panel.click()
      await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible()
    } finally {
      await page
        .getByRole('listitem')
        .filter({ hasText: name })
        .getByRole('button', { name: `${name} を削除` })
        .click()
      await expect(page.getByRole('listitem').filter({ hasText: name })).toBeHidden()
    }
  })
})
