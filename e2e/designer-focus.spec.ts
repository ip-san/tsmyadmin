import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`designer focus (${t.dialect})`, () => {
    test('draws the tables around one, shows comments, and offers keys the names suggest', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        // owners ← pets (a key); toys.pet_id names pets with no key; lone touches nothing.
        await sqlOn(page, space, 'CREATE TABLE owners (id INT PRIMARY KEY)')
        await sqlOn(
          page,
          space,
          'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))'
        )
        await sqlOn(page, space, 'CREATE TABLE toys (id INT PRIMARY KEY, pet_id INT)')
        await sqlOn(page, space, 'CREATE TABLE lone (id INT PRIMARY KEY)')
        await sqlOn(
          page,
          space,
          space.dialect === 'mysql'
            ? "ALTER TABLE owners COMMENT = 'かいぬし'"
            : "COMMENT ON TABLE owners IS 'かいぬし'"
        )
        const base = `/db/${space.database}/designer${space.schema ? `?schema=${space.schema}&` : '?'}`
        const box = (name: string) => page.getByRole('button', { name: new RegExp(`^テーブル ${name}（`) })

        // Around owners, one key out: owners and pets only. The address says so, so it can be shared.
        await page.goto(`${base}focus=owners&hops=1`)
        await expect(box('pets')).toBeVisible()
        await expect(box('toys')).toHaveCount(0)
        await expect(box('lone')).toHaveCount(0)
        await expect(
          page.getByText(/^owners から外部キーを 1 段たどった 2 テーブルを表示しています（全 4 テーブル）/)
        ).toBeVisible()

        // Back to every table from the control.
        await page.getByRole('combobox', { name: 'まわりだけ表示' }).selectOption('')
        await expect(page).not.toHaveURL(/focus=/)
        await expect(box('lone')).toBeVisible()
        // Unfocused, the status line is empty and takes no room between the toolbar and the diagram.
        await expect(page.locator('p[role="status"]:empty').first()).toHaveCSS('margin-bottom', '0px')

        // A box selected links to its table's overview.
        await box('pets').focus()
        await expect(page.getByRole('link', { name: 'このテーブルの概要' })).toBeVisible()

        // The comment, under its box and in its name.
        await page.getByRole('checkbox', { name: 'テーブルのコメントを出す' }).check()
        await expect(box('owners')).toHaveAccessibleName(/かいぬし$/)

        // toys.pet_id has no key: a candidate, made into one through the form (which shows the SQL first).
        await page.getByRole('checkbox', { name: '外部キーの無い参照の候補' }).check()
        const candidates = page.getByRole('region', { name: '外部キーの無い参照の候補' })
        const candidate = candidates.getByRole('listitem').filter({ hasText: 'toys.pet_id → pets.id' })
        await expect(candidate).toBeVisible()
        // The legend is a list too: count the candidates by their buttons.
        await expect(candidates.getByRole('button', { name: '外部キーにする…' })).toHaveCount(1)
        await candidate.getByRole('button', { name: '外部キーにする…' }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
      })
    })
  })
}
