import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, tableUrl, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`row graph (${t.dialect})`, () => {
    test('opens the rows around a row, one step at a time, with the rest to open in the table', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        // Eleven kids of parent 1: one more than the graph reads for a table.
        await sqlOn(page, space, 'CREATE TABLE parents (id INT PRIMARY KEY, name VARCHAR(20))')
        await sqlOn(
          page,
          space,
          'CREATE TABLE kids (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES parents (id))'
        )
        await sqlOn(page, space, "INSERT INTO parents VALUES (1, 'one'), (2, 'two')")
        const kids = Array.from({ length: 11 }, (_, i) => `(${i + 1}, 1)`).join(', ')
        await sqlOn(page, space, `INSERT INTO kids VALUES ${kids}`)

        await page.goto(`${tableUrl(space, 'parents')}${space.schema ? '&' : '?'}sort=id:asc`)
        await page.getByLabel('1 行目を選択').check()
        await page.getByRole('button', { name: '関係を図で見る' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('img', { name: /^行の関係の図/ })).toBeVisible()
        const rows = dialog.getByRole('region', { name: '図の行' }).getByRole('listitem')
        await expect(rows).toHaveCount(1)

        await dialog.getByRole('button', { name: 'parents id=1 のつながりを広げる' }).click()
        // Ten kids are read; the eleventh is counted, and opened in the table itself.
        await expect(rows.filter({ hasText: /^kids id=/ })).toHaveCount(10)
        const more = dialog.getByRole('link', { name: 'kids のほか 1 行を開く' })
        await expect(more).toBeVisible()
        await expect(dialog.getByRole('list', { name: '行どうしの参照' }).getByRole('listitem')).toHaveCount(10)

        // A kid leads back to its parent: the same row, not a second one.
        const kid = rows.filter({ hasText: /^kids id=/ }).first()
        await kid.getByRole('button', { name: /のつながりを広げる$/ }).click()
        await expect(kid).toContainText('広げた')
        await expect(rows.filter({ hasText: /^parents id=/ })).toHaveCount(1)

        await more.click()
        await expect(page).toHaveURL(/\/table\/kids/)
        await expect(page.getByRole('dialog')).toBeHidden()
      })
    })
  })
}
