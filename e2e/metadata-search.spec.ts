import { expect } from '@playwright/test'
import { login, TARGETS, test, withScratchSpace } from './helpers.ts'
import { tablesWithComments } from './metadata.ts'

for (const t of TARGETS) {
  test.describe(`metadata search (${t.dialect})`, () => {
    test('finds columns by name, type and comment across the tables', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await tablesWithComments(page, space)
        await page.goto(`/db/${space.database}/search${space.schema ? `?schema=${space.schema}` : ''}`)
        const term = page.getByLabel('探す語')
        const results = page.getByRole('table', { name: 'テーブル・カラムの検索結果' })

        // What is marked is what the term found: it changes with the term, so a result of the term before does
        // not pass for the new one.
        const marked = results.locator('mark')
        await term.fill('owner_id')
        await expect(marked).toHaveText(['owner_id'])
        await expect(results.getByRole('row').filter({ has: page.locator('mark') })).toContainText('pets')

        // By the column's comment.
        await term.fill('かいぬし')
        await expect(marked).toHaveText(['かいぬし'])
        await expect(results.getByRole('row').filter({ has: page.locator('mark') })).toContainText('owner_id')
        // In full-width capitals: the table owners and the column owner_id.
        await term.fill('ＯＷＮＥＲ')
        await expect(marked).toHaveText(['owner', 'owner'])

        // The link opens the table's structure.
        await results.getByRole('link', { name: 'pets' }).click()
        await expect(page).toHaveURL(/\/table\/pets\/structure/)
      })
    })
  })
}
