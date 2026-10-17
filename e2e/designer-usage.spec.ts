import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const designerUrl = `/db/${t.database}/designer${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`designer usage (${t.dialect})`, () => {
    test('lays how the tables are read over the diagram, with the indexes never read', async ({ page }) => {
      await login(page, t)
      // Read users in full once, so it has counts whatever the other tests did.
      await sqlOn(page, t, 'SELECT * FROM users')
      await page.goto(designerUrl)
      const users = page.getByRole('button', { name: /^テーブル users（/ })
      await expect(users).toBeVisible()
      // Nothing is laid over before it is asked for.
      await expect(page.getByText('全件で読まれることが多い')).toHaveCount(0)
      await expect(users).not.toHaveAttribute('data-tone')

      await page.getByRole('checkbox', { name: '使われ方を重ねる' }).check()
      // Which way a table is mostly read is the server's (and the other tests'); that users was read is not.
      await expect(page.getByText('全件で読まれることが多い')).toBeVisible()
      // Since when the counts run, or that it is not known (PostgreSQL's statistics never reset).
      await expect(page.getByText(/(からの(走査の回数|読んだ行数)です|いつからの数かは分かりません)/)).toBeVisible()
      await expect(page.getByRole('heading', { name: '読まれていないインデックス' })).toBeVisible()
      await expect(users).toHaveAttribute('data-tone', /^(scan|index)$/)
      // Its counts are in its name, as on its badge.
      await expect(users).toHaveAccessibleName(/^テーブル users（矢印キーで移動）: .+/)
      await page.getByRole('checkbox', { name: '使われ方を重ねる' }).uncheck()
      await expect(page.getByText('全件で読まれることが多い')).toHaveCount(0)
      await expect(users).not.toHaveAttribute('data-tone')
    })
  })
}
