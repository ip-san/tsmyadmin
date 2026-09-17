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
      await page.getByLabel('出力 1 行目の カラム').selectOption({ label: 'users.name' })
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('出力 2 行目の カラム').selectOption({ label: 'posts.title' })
      await page.getByLabel('出力 2 行目の 別名').fill('post')

      await page.getByRole('button', { name: '条件を追加' }).click()
      await page.getByLabel('グループ 1 の条件 1 の カラム').selectOption({ label: 'posts.title' })
      await page.getByLabel('グループ 1 の条件 1 の 演算子').selectOption({ label: 'を含む' })
      // A quote in the value: written into the SQL as a literal, not pasted in as text.
      await page.getByLabel('グループ 1 の条件 1 の 値').fill("b's p")

      await page.getByRole('button', { name: 'SQL を作成' }).click()
      const generated = page.locator('pre')
      await expect(generated).toContainText('LEFT JOIN')
      await expect(generated).toContainText("b''s p")
      // Changing a choice hides the SQL, which no longer matches it.
      await page.getByLabel('出力 2 行目の 別名').fill('title')
      await expect(generated).toHaveCount(0)
      await expect(page.getByText('選択が変わりました')).toBeVisible()
      await page.getByRole('button', { name: 'SQL を作成' }).click()

      await page.getByRole('button', { name: 'SQL タブで開く' }).click()
      await expect(page).toHaveURL(/\/sql/)
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      const result = page.getByRole('region', { name: '文 1' })
      await expect(result.getByRole('cell', { name: "Bob's post", exact: true })).toBeVisible()
      await expect(result).toContainText('1 行')
    })

    test('refuses tables that no foreign key connects', async ({ page }) => {
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('checkbox', { name: 'types_all', exact: true }).check()
      await page.getByRole('button', { name: 'SQL を作成' }).click()
      await expect(page.getByRole('alert')).toContainText('types_all')
      await expect(page.getByRole('button', { name: 'SQL タブで開く' })).toHaveCount(0)
    })
  })
}
