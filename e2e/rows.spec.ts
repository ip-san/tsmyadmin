import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

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

    test('inserts rows through the form (stays on the page, confirms, links back); duplicating a row prefills it', async ({
      page,
    }) => {
      await withScratchTable(page, t, async (table) => {
        await page.goto(tableUrl(t, table, '/insert'))
        await page.getByLabel('id', { exact: true }).fill('3')
        await page.getByLabel('name: NULL').uncheck()
        await page.getByLabel('name', { exact: true }).fill('three')
        await page.getByRole('button', { name: '挿入する' }).click()
        await expect(page.getByText('1 行を挿入しました')).toBeVisible()
        await expect(page).toHaveURL(/\/insert/)
        // The form is blank again and focus moved to its first field for the next row.
        await expect(page.getByLabel('id', { exact: true })).toHaveValue('')
        await expect(page.getByLabel('id', { exact: true })).toBeFocused()
        await page.getByRole('link', { name: '一覧へ戻る' }).click()
        await expect(page).toHaveURL(new RegExp(`/table/${table}(\\?|$)`))
        await expect(page.getByRole('cell', { name: 'three', exact: true })).toBeVisible()
        await expect(page.getByText('全 3 行')).toBeVisible()
        await page.goto(`${tableUrl(t, table)}${t.schema ? '&' : '?'}sort=id:asc`)
        await expect(page.getByText('全 3 行')).toBeVisible()
        await page.getByLabel('3 行目を複製').click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByLabel('name', { exact: true })).toHaveValue('three')
        await dialog.getByLabel('id', { exact: true }).fill('4')
        await dialog.getByRole('button', { name: '挿入する' }).click()
        await expect(page.getByText('全 4 行')).toBeVisible()
        await expect(page.getByRole('cell', { name: 'three', exact: true })).toHaveCount(2)
      })
    })

    test('remembers the page size across tables', async ({ page }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByLabel('表示行数').selectOption('25')
      await expect(page).toHaveURL(/limit=25/)
      await page.goto(tableUrl(t, 'posts'))
      await expect(page.getByLabel('表示行数')).toHaveValue('25')
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

        // Keyboard path: focus the cell and press Enter (no mouse).
        await page.getByRole('cell', { name: 'dos', exact: true }).focus()
        await page.keyboard.press('Enter')
        const kbEditor = page.getByLabel('name: セルを編集')
        await kbEditor.fill('tres')
        await kbEditor.press('Enter')
        await expect(page.getByRole('cell', { name: 'tres', exact: true })).toBeVisible()
        // Exactly one h1 per page (the table heading is an h2 inside the database page).
        expect(await page.locator('h1').count()).toBe(1)
      })
    })

    test('deletes selected rows after confirmation', async ({ page }) => {
      await withScratchTable(page, t, async (table) => {
        await page.goto(`${tableUrl(t, table)}${t.schema ? '&' : '?'}sort=id:asc`)
        await page.getByLabel('2 行目を選択').check()
        await page.getByRole('button', { name: '選択行を削除' }).click()
        await expect(page.getByRole('dialog')).toContainText('1 行を削除します')
        await page.getByRole('dialog').getByRole('button', { name: '削除する' }).click()
        await expect(page.getByText('1 行を削除しました')).toBeVisible()
        await expect(page.getByText('全 1 行')).toBeVisible()
        await expect(page.getByRole('cell', { name: 'two', exact: true })).toHaveCount(0)
      })
    })

    test('searches with column conditions and shows active filters', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/search'))
      await page.getByLabel('age: 条件').selectOption('gt')
      await page.getByLabel('age: 値').fill('30')
      await page.getByRole('button', { name: '検索する' }).click()
      await expect(page.getByText('全 2 行')).toBeVisible()
      await expect(page.getByText('絞り込み中:')).toBeVisible()
      await expect(page.getByRole('cell', { name: 'Carol', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '条件をクリア' }).click()
      await expect(page.getByText('全 5 行')).toBeVisible()
    })

    test('views are read-only', async ({ page }) => {
      await page.goto(tableUrl(t, 'active_users'))
      await expect(page.getByText(/ビュー、または行を一意に特定できるキーがないため編集できません/)).toBeVisible()
      await expect(page.getByRole('button', { name: '選択行を削除' })).toHaveCount(0)
    })
  })
}
