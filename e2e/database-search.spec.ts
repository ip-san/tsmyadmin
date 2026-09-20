import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const searchUrl = `/db/${t.database}/search${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`database search (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('searches for any of the words, only in columns named like', async ({ page }) => {
      await page.goto(searchUrl)
      await page.getByLabel('検索する語').fill('alice bob')
      await page.getByLabel('探し方').selectOption('any')
      await page.getByLabel('カラム名で絞る').fill('name')
      await page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' }).click()
      const results = page.getByRole('table', { name: 'データベース内を検索' })
      await expect(results.getByRole('row').filter({ hasText: /^users/ })).toContainText('2 行')
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

    test('stops between tables, and searches nothing further', async ({ page }) => {
      await page.goto(searchUrl)
      let sent = 0
      let release: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const isSearch = (url: URL) => url.pathname.endsWith('/search') && url.pathname.includes('/tables/')
      await page.route(isSearch, async (route) => {
        sent += 1
        await held
        await route.continue()
      })
      await page.getByLabel('検索する語').fill('a')
      await page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' }).click()
      await page.getByRole('button', { name: '中止する' }).click()
      await expect(page.getByText(/中止しました/)).toBeVisible()
      // The stopped table is still being searched on the server: another search would add a second scan.
      const search = page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' })
      await expect(search).toBeDisabled()
      release?.()
      await expect(search).toBeEnabled()
      // Give a loop that ignored the stop time to send more.
      await page.waitForTimeout(1500)
      expect(sent).toBe(1)
      await page.unroute(isSearch)
    })

    test('stops searching when the page is left', async ({ page }) => {
      await page.goto(searchUrl)
      let sent = 0
      const isSearch = (url: URL) => url.pathname.endsWith('/search') && url.pathname.includes('/tables/')
      await page.route(isSearch, async (route) => {
        sent += 1
        // Slow enough that the page is left while the first table is still being searched.
        await new Promise((resolve) => setTimeout(resolve, 400))
        await route.continue()
      })
      await page.getByLabel('検索する語').fill('a')
      await page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' }).click()
      await page.getByRole('link', { name: '構造', exact: true }).click()
      await page.waitForTimeout(2500)
      expect(sent).toBe(1)
      await page.unroute(isSearch)
    })

    test('deletes the rows a search found, after showing the DELETE and asking for the table name', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const table = `e2e_sdel_${Date.now().toString(36)}`
      const term = `zz${Date.now().toString(36)}`
      const run = (sql: string) =>
        page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql, ...(t.schema ? { schema: t.schema } : {}) },
        })
      try {
        await run(`CREATE TABLE ${table} (id INT PRIMARY KEY, note VARCHAR(40))`)
        await run(`INSERT INTO ${table} VALUES (1, '${term} one'), (2, 'keep'), (3, '${term} two')`)
        await page.goto(searchUrl)
        await page.getByLabel('検索する語').fill(term)
        await page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' }).click()
        const results = page.getByRole('table', { name: 'データベース内を検索' })
        await expect(results.getByRole('row').filter({ hasText: table })).toContainText('2 行')
        await page.getByRole('button', { name: `${table}: 一致した行を削除` }).click()
        await confirmPreview(page, /DELETE FROM/, table)
        await expect(results.getByRole('row').filter({ hasText: table })).toContainText('0 行')
        const left = await (await run(`SELECT COUNT(*) FROM ${table}`)).json()
        expect(JSON.stringify(left)).toContain('1')
      } finally {
        await run(`DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('a double click on Search does not stop the search it started', async ({ page }) => {
      await page.goto(searchUrl)
      await page.getByLabel('検索する語').fill('alice')
      await page
        .getByRole('form', { name: 'データベース内を検索' })
        .getByRole('button', { name: '検索する' })
        .dblclick()
      await expect(page.getByText(/テーブルを検索しました/)).toBeVisible()
      await expect(
        page.getByRole('form', { name: 'データベース内を検索' }).getByRole('button', { name: '検索する' })
      ).toBeEnabled()
      await expect(page.getByText(/中止しました/)).toHaveCount(0)
    })
  })
}
