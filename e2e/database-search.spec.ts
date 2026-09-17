import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const searchUrl = `/db/${t.database}/search${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`database search (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('finds a term across tables and opens the matching rows in the SQL tab', async ({ page }) => {
      await page.goto(searchUrl)
      await page.getByLabel('検索する語').fill('ALICE')
      await page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' }).click()
      const results = page.getByRole('table', { name: 'データベース内を検索' })
      // Case-insensitive, and one row even though both the name and the email contain it.
      await expect(results.getByRole('row').filter({ hasText: /^users/ })).toContainText('1 行')
      await expect(results.getByRole('row').filter({ hasText: /^posts/ })).toContainText('0 行')
      await expect(page.getByText(/テーブルを検索しました/)).toBeVisible()
      // Ready for another search once the run is over.
      await expect(
        page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' })
      ).toBeEnabled()

      await page.getByRole('button', { name: 'users の一致した行を SQL タブで開く', exact: true }).click()
      await expect(page).toHaveURL(/\/sql/)
      const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
      await expect(editor).toContainText('users')
      await expect(editor).toContainText('%ALICE%')
    })

    test('stops between tables', async ({ page }) => {
      await page.goto(searchUrl)
      // Hold every table's request until Stop has been pressed, so the stop lands mid-run deterministically.
      let release: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const isSearch = (url: URL) => url.pathname.endsWith('/search') && url.pathname.includes('/tables/')
      await page.route(isSearch, async (route) => {
        await held
        await route.continue()
      })
      await page.getByLabel('検索する語').fill('a')
      await page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' }).click()
      await page.getByRole('button', { name: '中止する' }).click()
      release?.()
      await expect(page.getByText(/中止しました/)).toBeVisible()
      // Only the table already in flight finished; the rest were never searched.
      await expect(page.getByText('1 / ', { exact: false })).toBeVisible()
      await page.unroute(isSearch)
    })
  })
}
