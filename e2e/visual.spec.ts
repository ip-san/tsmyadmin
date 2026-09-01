import { expect, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

const t = TARGETS[0]
if (!t) throw new Error('no targets')

test.describe('visual regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  // The sidebar lists every table, so leftovers from aborted integration runs would break the baseline; mask it.
  // Viewport-sized shots: full-page height (and thus the masked sidebar) varies with content.
  const options = (page: Parameters<typeof login>[0]) => ({ fullPage: false, mask: [page.locator('aside')] })

  test('login', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('ホスト').waitFor()
    await expect(page).toHaveScreenshot('login.png', { fullPage: false })
  })

  test('browse', async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'users'))
    await page.getByText('全 5 件').waitFor()
    await expect(page).toHaveScreenshot('browse.png', options(page))
  })

  test('structure', async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'posts', '/structure'))
    await page.getByRole('table', { name: '外部キー' }).waitFor()
    await expect(page).toHaveScreenshot('structure.png', options(page))
  })
})
