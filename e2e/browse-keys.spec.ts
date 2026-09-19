import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`browse by key, foreign key names, profiling (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('sorts by an index and names the referenced rows', async ({ page }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      const byKey = page.getByLabel('キーで並べ替え')
      const primary = t.dialect === 'mysql' ? 'PRIMARY' : 'users_pkey'
      await byKey.selectOption({ label: `${primary}（降順）` })
      await expect(page).toHaveURL(/sort=id(%3A|:)desc/)
      await expect(page.getByRole('table', { name: 'users' }).getByRole('row').nth(1)).toContainText('5')
      await expect(byKey).toHaveValue('id:desc')

      await page.goto(tableUrl(t, 'posts'))
      await page.locator('summary', { hasText: '表示のしかた' }).click()
      await page.getByLabel('外部キーの参照先の名前を併記').check()
      // users.id 1 is Alice (the fixtures' first user).
      await expect(page.getByRole('table', { name: 'posts' }).getByText('Alice').first()).toBeVisible()
    })

    test('profiles each statement in the SQL console', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      const option = page.getByLabel('プロファイリング')
      if (t.dialect === 'postgres') {
        await expect(option).toHaveCount(0)
        return
      }
      await option.check()
      await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
      await page.keyboard.type('SELECT COUNT(*) FROM users')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      await page.getByText(/^プロファイル（合計/).click()
      await expect(page.getByRole('table', { name: 'プロファイル' }).getByRole('row').nth(1)).toBeVisible()
    })
  })
}
