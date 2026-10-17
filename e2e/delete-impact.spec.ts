import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`delete impact (${t.dialect})`, () => {
    test('shows what a delete would reach through ON DELETE, step by step, and deletes nothing', async ({ page }) => {
      // The whole picture at once: the steps do not move on their own, so what is shown can be checked.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await login(page, t)
      await page.goto(`${tableUrl(t, 'users')}${t.schema ? '&' : '?'}sort=id:asc`)
      await page.getByLabel('1 行目を選択').check()
      await page.getByRole('button', { name: '選択行を削除' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: '影響を見る' }).click()

      // Alice has two posts, which fk_posts_user (ON DELETE CASCADE) takes with her.
      await expect(dialog.getByRole('img', { name: '削除の影響の図' })).toBeVisible()
      const last = dialog.getByRole('button', { name: /^2\. 1 段目: posts の 2 行も消える（fk_posts_user）$/ })
      await expect(last).toHaveAttribute('aria-current', 'step')
      await expect(dialog.getByRole('button', { name: '1. users の 1 行を消す' })).toBeVisible()
      await expect(dialog.getByRole('alert')).toHaveCount(0)

      await dialog.getByRole('button', { name: '最初へ' }).click()
      await expect(dialog.getByRole('button', { name: '1. users の 1 行を消す' })).toHaveAttribute(
        'aria-current',
        'step'
      )
      await expect(dialog.getByText('1 / 2 段目')).toBeVisible()

      await dialog.getByRole('button', { name: 'キャンセル' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByRole('cell', { name: 'Alice', exact: true })).toBeVisible()
    })
  })
}
