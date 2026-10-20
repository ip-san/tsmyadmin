import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, tableUrl, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`table overview (${t.dialect})`, () => {
    test('says what a table is, what its columns hold, and what is a key away', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await sqlOn(page, space, 'CREATE TABLE owners (id INT PRIMARY KEY)')
        await sqlOn(
          page,
          space,
          'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, kind VARCHAR(10), note VARCHAR(10), FOREIGN KEY (owner_id) REFERENCES owners (id))'
        )
        await sqlOn(page, space, 'INSERT INTO owners VALUES (1), (2)')
        await sqlOn(
          page,
          space,
          "INSERT INTO pets VALUES (1, 1, 'cat', NULL), (2, 2, 'cat', NULL), (3, 1, 'cat', NULL)"
        )
        await sqlOn(page, space, 'CREATE VIEW cats AS SELECT id FROM pets')

        await page.goto(tableUrl(space, 'pets', '/overview'))
        await expect(page.getByText('ほかのテーブルを参照する、記録や明細のテーブルのようです')).toBeVisible()
        const columns = page.getByRole('table', { name: 'カラムごとの NULL の割合と値の種類' })
        const row = (name: string) =>
          columns.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })
        await expect(row('id')).toContainText('行ごとに違う値')
        await expect(row('kind')).toContainText('1 つの値だけ')
        await expect(row('note')).toContainText('すべて NULL')
        await expect(row('owner_id')).toContainText('2')
        await expect(page.getByText('全 3 行を数えました')).toBeVisible()
        await expect(page.getByRole('table', { name: '行の例' }).getByRole('row')).toHaveCount(4)
        await expect(page.getByRole('list', { name: 'つながるテーブルの外部キー' })).toContainText(
          'pets（owner_id）→ owners'
        )
        const usedBy = page.locator('section', { has: page.getByRole('heading', { name: 'これを使うもの' }) })
        await expect(usedBy.getByRole('listitem')).toHaveText(['ビュー cats'])

        // The table everything refers to.
        await page.goto(tableUrl(space, 'owners', '/overview'))
        await expect(page.getByText('ほかのテーブルから参照される、元になるテーブルのようです（マスタ）')).toBeVisible()
      })
    })

    test('presents a table: its key, what it refers to and what refers to it, and what is further', async ({
      page,
    }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await sqlOn(page, space, 'CREATE TABLE orgs (id INT PRIMARY KEY)')
        await sqlOn(
          page,
          space,
          'CREATE TABLE owners (id INT PRIMARY KEY, org_id INT, FOREIGN KEY (org_id) REFERENCES orgs (id))'
        )
        await sqlOn(
          page,
          space,
          'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))'
        )
        await sqlOn(
          page,
          space,
          'CREATE TABLE visits (id INT PRIMARY KEY, pet_id INT, FOREIGN KEY (pet_id) REFERENCES pets (id))'
        )
        // Nothing plays by itself: the scenes are moved by hand.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(tableUrl(space, 'pets', '/overview'))
        await page.getByRole('button', { name: 'プレゼンで見る' }).click()
        const tour = page.getByRole('dialog', { name: 'テーブルのプレゼン: pets' })
        const title = tour.getByRole('heading', { level: 3 })
        await expect(title).toHaveText('pets')
        await page.keyboard.press('ArrowRight')
        await expect(tour.getByText('行は id で 1 つに決まります')).toBeVisible()
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('参照するテーブル（1）')
        await expect(tour.getByText('pets.owner_id が owners.id を参照', { exact: false })).toBeVisible()
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('参照してくるテーブル（1）')
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('2 段先のテーブル（1）')
        await expect(tour.getByText('となりのテーブルを通して、ここまでつながります。orgs')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(tour).toBeHidden()
      })
    })
  })
}
