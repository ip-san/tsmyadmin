import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`zoom search (${t.dialect})`, () => {
    test('plots two numeric columns and opens the row behind a point', async ({ page }) => {
      await login(page, t)
      const table = `e2e_zoom_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, w INT, h DECIMAL(6,1), label VARCHAR(10))`)
      await sql(
        page,
        t,
        `INSERT INTO ${table} (id, w, h, label) VALUES (1, 10, 1.5, 'a'), (2, 20, 2.5, 'b'), (3, NULL, 3.5, 'c')`
      )
      try {
        await page.goto(tableUrl(t, table, '/search'))
        const zoom = page.getByRole('region', { name: 'ズーム検索' })
        // Only the numeric columns are offered as axes.
        await expect(zoom.getByLabel('横軸').locator('option')).toHaveText(['id', 'w', 'h'])
        // The defaults (the first two numeric columns) plot as shown, before anything is chosen.
        await zoom.getByRole('button', { name: '散布図を表示' }).click()
        await expect(zoom.getByText('2 点（値が NULL か数値でない 1 行は除外）')).toBeVisible()
        await zoom.getByLabel('横軸').selectOption('w')
        await zoom.getByLabel('縦軸').selectOption('h')
        await zoom.getByRole('button', { name: '散布図を表示' }).click()
        await expect(zoom.getByText('2 点（値が NULL か数値でない 1 行は除外）')).toBeVisible()
        await expect(zoom.locator('circle')).toHaveCount(2)
        await expect(zoom.locator('svg text').filter({ hasText: /^h$/ })).toBeVisible()
        // A click on the point, and the same through the table for the keyboard.
        await zoom.locator('circle').nth(1).click()
        await expect(zoom.getByRole('definition').filter({ hasText: 'b' })).toBeVisible()
        await zoom.getByText('点を表で見る（2 点）').click()
        const first = zoom.getByRole('button', { name: 'w = 10、h = 1.5 の行を選ぶ' })
        await first.click()
        await expect(first).toHaveAttribute('aria-pressed', 'true')
        await zoom.getByRole('link', { name: 'この行を表示タブで開く' }).click()
        await expect(page.getByText('全 1 行')).toBeVisible()
        await expect(page.getByRole('cell', { name: 'a', exact: true })).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('lets a pick lapse once the rows are fetched again', async ({ page }) => {
      await login(page, t)
      const table = `e2e_zoom2_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, w INT)`)
      await sql(page, t, `INSERT INTO ${table} (id, w) VALUES (1, 10), (2, 20)`)
      try {
        await page.goto(tableUrl(t, table, '/search'))
        const zoom = page.getByRole('region', { name: 'ズーム検索' })
        await zoom.getByRole('button', { name: '散布図を表示' }).click()
        await zoom.locator('circle').first().click()
        await expect(zoom.getByRole('heading', { name: '選んだ行' })).toBeVisible()
        // A statement in the docked console refetches the rows: the position picked may now be another row.
        await page.getByRole('button', { name: 'コンソール', exact: true }).click()
        const dock = page.getByRole('region', { name: 'SQL コンソール（画面の下に常駐）' })
        await dock.getByRole('textbox', { name: 'SQL エディタ' }).click()
        await page.keyboard.type(`DELETE FROM ${table} WHERE id = 1`)
        await dock.getByRole('button', { name: '実行する', exact: true }).click()
        await expect(zoom.getByText('1 点', { exact: true })).toBeVisible()
        await expect(zoom.getByRole('heading', { name: '選んだ行' })).toBeHidden()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
