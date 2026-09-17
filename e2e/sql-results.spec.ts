import { expect, type Page } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

declare global {
  interface Window {
    __copied?: string
    __printed?: number
    /** What was about to go on paper when print() was called. */
    __paper?: { rows: number; firstHidden: boolean }
  }
}

async function run(page: Page, sql: string) {
  const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(sql)
  await page.getByRole('button', { name: '実行する', exact: true }).click()
}

for (const t of TARGETS) {
  const sqlUrl = `/db/${t.database}/sql${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`SQL results: copy, print, chart (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      // Neither the clipboard nor the print dialog can be driven the same way in every engine: both are replaced
      // by recorders, so what is tested is what the page hands them.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              window.__copied = text
            },
          },
        })
        window.print = () => {
          window.__printed = (window.__printed ?? 0) + 1
          window.__paper = {
            rows: document.querySelectorAll('section[aria-label="文 2"] tbody tr').length,
            firstHidden:
              document.querySelector('section[aria-label="文 1"]')?.classList.contains('print:hidden') ?? false,
          }
        }
      })
      await login(page, t)
      await page.goto(sqlUrl)
    })

    test('copies a result as tab-separated text with a header', async ({ page }) => {
      await run(page, 'SELECT name, age FROM users WHERE id <= 2 ORDER BY id')
      const result = page.getByRole('region', { name: '文 1' })
      await result.getByRole('button', { name: '文 1 の結果: コピー' }).click()
      await expect(result.getByText('クリップボードにコピーしました（タブ区切り）')).toBeVisible()
      expect(await page.evaluate(() => window.__copied)).toBe('name\tage\nAlice\t30\nBob\tNULL')
    })

    test('prints one result alone, every row of it', async ({ page }) => {
      // 300 rows: above the point where the screen shows only a window of the rows.
      await run(
        page,
        'SELECT 1 AS first; WITH RECURSIVE s (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 300) SELECT n FROM s'
      )
      const second = page.getByRole('region', { name: '文 2' })
      await expect(second.getByText('300 行', { exact: false })).toBeVisible()
      await second.getByRole('button', { name: '文 2 の結果: 印刷' }).click()
      expect(await page.evaluate(() => window.__printed)).toBe(1)
      // At the moment of printing: every row laid out, the other statement left off the paper.
      expect(await page.evaluate(() => window.__paper)).toEqual({ rows: 300, firstHidden: true })

      // The stub never reports the print finished, as a browser whose print() returns early would not: the paper
      // layout stays until the user is back on the page.
      await expect(page.getByRole('region', { name: '文 1' })).toHaveClass(/print:hidden/)
      await page.keyboard.press('Shift')
      await expect(page.getByRole('region', { name: '文 1' })).not.toHaveClass(/print:hidden/)

      // A print the browser starts itself: the page chrome is left off, every result goes on paper.
      await page.emulateMedia({ media: 'print' })
      await expect(page.getByRole('complementary')).toBeHidden()
      await expect(page.getByRole('textbox', { name: 'SQL エディタ' })).toBeHidden()
      await expect(page.getByRole('region', { name: '文 1' })).toBeVisible()
      await expect(second.locator('tbody tr')).toHaveCount(300)
    })

    test('charts numeric columns, leaving out rows without a number', async ({ page }) => {
      await run(page, 'SELECT name, age FROM users ORDER BY id')
      const result = page.getByRole('region', { name: '文 1' })
      await result.getByRole('button', { name: '文 1 の結果: グラフ' }).click()
      // Five users; Bob's age is NULL, so four bars.
      await expect(result.locator('rect[data-series="age"]')).toHaveCount(4)
      await result.getByLabel('グラフの種類').selectOption('line')
      // The line lifts over the missing value: two separate strokes.
      const d = await result.locator('path[data-series="age"]').getAttribute('d')
      expect(d?.match(/M/g)).toHaveLength(2)
    })
  })
}
