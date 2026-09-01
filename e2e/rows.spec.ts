import { expect, type Page, test } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl } from './helpers.ts'

/** Creates a throw-away table through the API (the browser session's cookie is reused). */
async function withScratchTable(page: Page, t: Target, fn: (table: string) => Promise<void>) {
  const table = `e2e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const sql = (s: string) =>
    page.request.post(`/api/databases/${t.database}/sql`, {
      data: { sql: s, ...(t.schema ? { schema: t.schema } : {}) },
    })
  const created = await sql(
    `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(50) NULL, n INT NULL); INSERT INTO ${table} (id, name, n) VALUES (1, 'one', 10), (2, 'two', NULL)`
  )
  expect(created.ok()).toBe(true)
  try {
    await fn(table)
  } finally {
    await sql(`DROP TABLE ${table}`)
  }
}

for (const t of TARGETS) {
  test.describe(`rows (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('inserts a row through the form', async ({ page }) => {
      await withScratchTable(page, t, async (table) => {
        await page.goto(tableUrl(t, table, '/insert'))
        await page.getByLabel('id', { exact: true }).fill('3')
        await page.getByLabel('name: NULL').uncheck()
        await page.getByLabel('name', { exact: true }).fill('three')
        await page.getByRole('button', { name: '挿入する' }).click()
        await expect(page).toHaveURL(new RegExp(`/table/${table}(\\?|$)`))
        await expect(page.getByRole('cell', { name: 'three', exact: true })).toBeVisible()
        await expect(page.getByText('全 3 件')).toBeVisible()
      })
    })

    test('edits a row through the dialog and a cell inline', async ({ page }) => {
      await withScratchTable(page, t, async (table) => {
        await page.goto(`${tableUrl(t, table)}${t.schema ? '&' : '?'}sort=id:asc`)
        await page.getByRole('button', { name: '1 行目を編集' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('name', { exact: true }).fill('uno')
        await dialog.getByLabel('n: NULL').check()
        await dialog.getByRole('button', { name: '保存する' }).click()
        await expect(page.getByRole('cell', { name: 'uno', exact: true })).toBeVisible()
        await expect(page.getByText('行を更新しました')).toBeVisible()

        await page.getByRole('cell', { name: 'two', exact: true }).dblclick()
        const editor = page.getByLabel('name: セルを編集')
        await editor.fill('dos')
        await editor.press('Enter')
        await expect(page.getByRole('cell', { name: 'dos', exact: true })).toBeVisible()
      })
    })

    test('deletes selected rows after confirmation', async ({ page }) => {
      await withScratchTable(page, t, async (table) => {
        await page.goto(`${tableUrl(t, table)}${t.schema ? '&' : '?'}sort=id:asc`)
        await page.getByLabel('2 行目を選択').check()
        await page.getByRole('button', { name: '選択行を削除' }).click()
        await expect(page.getByRole('dialog')).toContainText('1 行を削除します')
        await page.getByRole('dialog').getByRole('button', { name: '削除' }).click()
        await expect(page.getByText('1 行を削除しました')).toBeVisible()
        await expect(page.getByText('全 1 件')).toBeVisible()
        await expect(page.getByRole('cell', { name: 'two', exact: true })).toHaveCount(0)
      })
    })

    test('searches with column conditions and shows active filters', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/search'))
      await page.getByLabel('age: 条件').selectOption('gt')
      await page.getByLabel('age: 値').fill('30')
      await page.getByRole('button', { name: '検索する' }).click()
      await expect(page.getByText('全 2 件')).toBeVisible()
      await expect(page.getByText('絞り込み中:')).toBeVisible()
      await expect(page.getByRole('cell', { name: 'Carol', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '条件をクリア' }).click()
      await expect(page.getByText('全 5 件')).toBeVisible()
    })

    test('views are read-only', async ({ page }) => {
      await page.goto(tableUrl(t, 'active_users'))
      await expect(page.getByText('編集不可')).toBeVisible()
      await expect(page.getByRole('button', { name: '選択行を削除' })).toHaveCount(0)
    })
  })
}
