import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const queryUrl = `/db/${t.database}/query${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`query builder (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
      await page.goto(queryUrl)
    })

    test('joins tables along a foreign key and runs the result in the SQL tab', async ({ page }) => {
      await page.getByRole('checkbox', { name: 'posts', exact: true }).check()
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()

      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('出力 1 行目のカラム').selectOption({ label: 'users.name' })
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('出力 2 行目のカラム').selectOption({ label: 'posts.title' })
      await page.getByLabel('出力 2 行目の別名').fill('post')

      await page.getByRole('button', { name: '条件を追加' }).click()
      await page.getByLabel('グループ 1 の条件 1のカラム').selectOption({ label: 'posts.title' })
      await page.getByLabel('グループ 1 の条件 1の演算子').selectOption({ label: 'を含む' })
      // A quote in the value: written into the SQL as a literal, not pasted in as text.
      await page.getByLabel('グループ 1 の条件 1の値').fill("b's p")

      await page.getByRole('button', { name: 'SQL を作成' }).click()
      const generated = page.locator('pre')
      await expect(generated).toContainText('LEFT JOIN')
      await expect(generated).toContainText("b''s p")
      // Changing a choice hides the SQL, which no longer matches it.
      await page.getByLabel('出力 2 行目の別名').fill('title')
      await expect(generated).toHaveCount(0)
      await expect(page.getByText('選択が変わりました')).toBeVisible()
      await page.getByRole('button', { name: 'SQL を作成' }).click()

      await page.getByRole('button', { name: 'SQL タブで開く' }).click()
      await expect(page).toHaveURL(/\/sql/)
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      const result = page.getByRole('region', { name: '文 1' })
      await expect(result.getByRole('cell', { name: "Bob's post", exact: true })).toBeVisible()
      await expect(result).toContainText(/(^|[^\d,])1 行/)
    })

    test('shows the join order and clears rows of a table that is unticked', async ({ page }) => {
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('checkbox', { name: 'posts', exact: true }).check()
      await expect(page.getByText('結合の順: users → posts')).toBeVisible()
      await page.getByRole('button', { name: '条件を追加' }).click()
      await page.getByLabel('グループ 1 の条件 1のカラム').selectOption({ label: 'posts.title' })
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('出力 1 行目のカラム').selectOption({ label: 'users.name' })

      // Removing a row keeps keyboard focus on a control that stays.
      await page.getByRole('button', { name: '出力 1 行目を外す' }).click()
      await expect(page.getByRole('button', { name: 'カラムを追加' })).toBeFocused()

      await page.getByRole('checkbox', { name: 'posts', exact: true }).uncheck()
      // The condition on posts goes with it, instead of staying on screen while being left out of the SQL.
      await expect(page.getByLabel('グループ 1 の条件 1のカラム')).toHaveCount(0)
      await page.getByRole('checkbox', { name: 'posts', exact: true }).check()
      await expect(page.getByText('結合の順: users → posts')).toBeVisible()
    })

    test('refuses tables that no foreign key connects', async ({ page }) => {
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('checkbox', { name: 'types_all', exact: true }).check()
      await page.getByRole('button', { name: 'SQL を作成' }).click()
      await expect(page.getByRole('alert')).toContainText('types_all')
      await expect(page.getByRole('button', { name: 'SQL タブで開く' })).toHaveCount(0)
    })

    test('saves a setup under a name and puts it back after a reload', async ({ page }) => {
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('出力 1 行目のカラム').selectOption({ label: 'name' })
      await page.getByRole('button', { name: '条件を追加' }).click()
      await page.getByLabel('グループ 1 の条件 1のカラム').selectOption({ label: 'id' })
      await page.getByLabel('グループ 1 の条件 1の演算子').selectOption('in')
      await page.getByLabel('グループ 1 の条件 1の値').fill('1, 2')
      const panel = page.locator('details', { has: page.locator('summary', { hasText: '保存した組み立て' }) })
      await panel.locator('summary').click()
      await panel.getByLabel('名前', { exact: true }).fill('first two')
      await panel.getByRole('button', { name: '保存する' }).click()
      await page.reload()
      await panel.locator('summary').click()
      await panel.getByRole('listitem').filter({ hasText: 'first two' }).getByRole('button').first().click()
      await expect(page.getByRole('checkbox', { name: 'users', exact: true })).toBeChecked()
      await expect(page.getByLabel('グループ 1 の条件 1の値')).toHaveValue('1, 2')
      await page.getByRole('button', { name: 'SQL を作成' }).click()
      await expect(page.locator('pre')).toContainText('IN (')
    })

    test('joins them when the join is spelled out', async ({ page }) => {
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('checkbox', { name: 'types_all', exact: true }).check()
      await page.getByLabel('types_all の結合', { exact: true }).selectOption('inner')
      await page.getByLabel('types_all の結合: このテーブルのカラム').selectOption({ label: 'types_all.id' })
      await page.getByLabel('types_all の結合: 前のテーブルのカラム').selectOption({ label: 'users.id' })
      await page.getByRole('button', { name: 'SQL を作成' }).click()
      await expect(page.locator('pre')).toContainText(/INNER JOIN .*types_all.* ON .*types_all.*id.* = .*users.*id/)
    })
  })
}
