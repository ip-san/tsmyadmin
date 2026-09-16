import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

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

  /**
   * The navigation, which the other shots mask out entirely and so never cover.
   *
   * Clipped to a fixed rectangle instead of masked: the tree's height varies with whatever databases the server
   * happens to hold, so any element-shaped mask would move and break the baseline. A fixed rectangle over the top
   * of the panel does not, and it still covers the panel's width, border, background and the filter box.
   *
   * The first row is asserted before the shot. Leftover databases from aborted integration runs sort in among the
   * server's own schemas, and without this a stray one would show up as an unreadable pixel diff rather than as
   * "the tree does not start where this test assumes".
   */
  test('sidebar', async ({ page }) => {
    await login(page, t)
    // The rectangle ends on a row boundary, so a font or spacing change shows as a whole row rather than as a
    // sliver of one. These three are the server's own schemas and are always present.
    const rows = page.locator('aside a')
    for (const [i, name] of ['information_schema', 'mysql', 'performance_schema'].entries()) {
      await expect(rows.nth(i)).toHaveText(name)
    }
    await expect(page).toHaveScreenshot('sidebar.png', { clip: { x: 0, y: 49, width: 256, height: 126 } })
  })

  test('browse', async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'users'))
    await page.getByText('全 5 行').waitFor()
    await expect(page).toHaveScreenshot('browse.png', options(page))
  })

  test('structure', async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'posts', '/structure'))
    await page.getByRole('table', { name: '外部キー' }).waitFor()
    await expect(page).toHaveScreenshot('structure.png', options(page))
  })
})
