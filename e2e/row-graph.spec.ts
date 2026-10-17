import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`row graph (${t.dialect})`, () => {
    test('opens the rows around a row, one step at a time', async ({ page }) => {
      await login(page, t)
      await page.goto(`${tableUrl(t, 'users')}${t.schema ? '&' : '?'}sort=id:asc`)
      await page.getByLabel('1 行目を選択').check()
      await page.getByRole('button', { name: '関係を図で見る' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('img', { name: /^行の関係の図/ })).toBeVisible()
      const rows = dialog.getByRole('region', { name: '図の行' }).getByRole('listitem')
      await expect(rows).toHaveCount(1)

      // Alice has two posts.
      await dialog.getByRole('button', { name: 'users id=1 のつながりを広げる' }).click()
      await expect(rows.filter({ hasText: /^posts id=/ })).toHaveCount(2)

      // A post leads back to Alice: the same row, not a second one.
      await rows
        .filter({ hasText: /^posts id=/ })
        .first()
        .getByRole('button', { name: /のつながりを広げる$/ })
        .click()
      await expect(rows.filter({ hasText: /^posts id=/ }).first()).toContainText('広げた')
      await expect(rows).toHaveCount(3)
      await dialog.getByRole('button', { name: '閉じる' }).last().click()
      await expect(dialog).toBeHidden()
    })
  })
}
