import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const designerUrl = `/db/${t.database}/designer${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`designer (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
      await page.goto(designerUrl)
    })

    test('lists the foreign keys and draws the tables they connect', async ({ page }) => {
      const keys = page.getByRole('table', { name: '外部キー' })
      const row = keys.getByRole('row').filter({ hasText: 'fk_posts_user' })
      await expect(row.getByRole('cell')).toHaveText([
        'posts',
        'user_id',
        'users',
        'id',
        'CASCADE',
        'RESTRICT',
        'fk_posts_user',
        '削除',
      ])
      await expect(page.getByRole('button', { name: /^テーブル posts/ })).toBeVisible()
      await expect(page.getByRole('button', { name: /^テーブル users/ })).toBeVisible()
      // One line per drawn key.
      await expect(page.locator('figure svg path')).not.toHaveCount(0)
    })

    test('moves a table by keyboard and by dragging, keeps the layout across a reload, and resets it', async ({
      page,
    }) => {
      const posts = page.getByRole('button', { name: /^テーブル posts/ })
      const start = await posts.getAttribute('transform')
      await posts.focus()
      await page.keyboard.press('Shift+ArrowDown')
      await expect(posts).not.toHaveAttribute('transform', start ?? '')
      const afterKeys = await posts.getAttribute('transform')

      const box = await posts.boundingBox()
      if (!box) throw new Error('posts box is not rendered')
      await page.mouse.move(box.x + 20, box.y + 10)
      await page.mouse.down()
      await page.mouse.move(box.x + 60, box.y + 70, { steps: 5 })
      await page.mouse.up()
      await expect(posts).not.toHaveAttribute('transform', afterKeys ?? '')
      const moved = await posts.getAttribute('transform')

      await page.reload()
      await expect(page.getByRole('button', { name: /^テーブル posts/ })).toHaveAttribute('transform', moved ?? '')

      await page.getByRole('button', { name: '配置を元に戻す' }).click()
      // Clicking a box without dragging it saves nothing, even if the hand moves a pixel or two.
      const users = await page.getByRole('button', { name: /^テーブル users/ }).boundingBox()
      if (!users) throw new Error('users box is not rendered')
      await page.mouse.move(users.x + 20, users.y + 10)
      await page.mouse.down()
      await page.mouse.move(users.x + 22, users.y + 11)
      await page.mouse.up()
      await expect(page.getByRole('button', { name: '配置を元に戻す' })).toBeDisabled()
      await expect(page.getByRole('button', { name: /^テーブル posts/ })).toHaveAttribute('transform', start ?? '')
    })
  })
}
