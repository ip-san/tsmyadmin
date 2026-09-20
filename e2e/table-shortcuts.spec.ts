import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

const t = TARGETS[0] as (typeof TARGETS)[number]

test('lists recently opened tables and favorites in the sidebar', async ({ page }) => {
  await login(page, t)
  const sidebar = page.getByRole('complementary')
  // Each page records its visit once it has rendered: wait for it before moving on.
  await page.goto(tableUrl(t, 'users'))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('users')
  await page.goto(tableUrl(t, 'posts'))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('posts')
  const recent = sidebar.locator('details', { hasText: '最近使ったテーブル' })
  await expect(recent.getByRole('link')).toHaveText([/posts$/, /users$/])

  // A star by the table name adds it to the favorites; pressed again, it takes it out.
  const star = page.getByRole('button', { name: 'お気に入りに追加' })
  await star.click()
  await expect(page.getByRole('button', { name: 'お気に入りから外す' })).toHaveAttribute('aria-pressed', 'true')
  const favorites = sidebar.locator('details', { hasText: 'お気に入り' }).first()
  await expect(favorites.getByRole('link', { name: /posts$/ })).toBeVisible()
  await favorites.getByRole('link', { name: /posts$/ }).click()
  await expect(page).toHaveURL(/\/table\/posts/)
  await page.getByRole('button', { name: 'お気に入りから外す' }).click()
  await expect(sidebar.locator('details', { hasText: 'お気に入り' }).filter({ hasNotText: '最近' })).toHaveCount(0)
})

test('stars a table from the structure list of its database', async ({ page }) => {
  await login(page, t)
  await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
  const star = page.getByRole('button', { name: 'users: お気に入りに追加', exact: true })
  await star.click()
  await expect(page.getByRole('button', { name: 'users: お気に入りから外す', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const favorites = page.getByRole('complementary').locator('details', { hasText: 'お気に入り' }).first()
  await expect(favorites.getByRole('link', { name: /users$/ })).toBeVisible()
  await page.getByRole('button', { name: 'users: お気に入りから外す', exact: true }).click()
  await expect(page.getByRole('button', { name: 'users: お気に入りに追加', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
})
