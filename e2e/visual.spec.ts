import { expect, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

const t = TARGETS[0]
if (!t) throw new Error('no targets')

test.describe('visual regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('login', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('ホスト').waitFor()
    await expect(page).toHaveScreenshot('login.png', { fullPage: true })
  })

  test('browse', async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'users'))
    await page.getByText('全 5 件').waitFor()
    await expect(page).toHaveScreenshot('browse.png', { fullPage: true })
  })

  test('structure', async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'posts', '/structure'))
    await page.getByRole('table', { name: '外部キー' }).waitFor()
    await expect(page).toHaveScreenshot('structure.png', { fullPage: true })
  })
})
