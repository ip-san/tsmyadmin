import { expect } from '@playwright/test'
import { petsAndLogs } from './database-map.ts'
import { login, sqlOn, TARGETS, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`database map (${t.dialect})`, () => {
    test('sorts the tables by role and names what to look at', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await petsAndLogs(page, space)
        const search = space.schema ? `?schema=${space.schema}` : ''
        await page.goto(`/db/${space.database}${search}`)
        await page.getByRole('link', { name: /^見取り図/ }).click()
        await expect(page).toHaveURL(/\/map/)

        await expect(page.getByRole('status').filter({ hasText: 'テーブル 3・ビュー 0' })).toBeVisible()
        await expect(page.getByRole('list', { name: 'マスタ（参照されるだけ）' })).toHaveText('owners')
        await expect(page.getByRole('list', { name: '記録・明細（参照するだけ）' })).toHaveText('pets')
        await expect(page.getByRole('list', { name: 'どことも外部キーでつながらない' })).toHaveText('logs')
        await expect(page.getByRole('list', { name: 'よく参照されるテーブル' })).toContainText('owners')
        await expect(page.getByRole('region', { name: '主キーの無いテーブル' }).getByRole('link')).toHaveText('logs')
        // MySQL makes an index for every foreign key; PostgreSQL does not.
        const unindexed = page.getByRole('region', { name: 'インデックスの無い外部キー' })
        if (space.dialect === 'mysql') await expect(unindexed).toContainText('インデックスの無い外部キーはありません')
        else await expect(unindexed.getByRole('link')).toHaveText('pets（owner_id）→ owners')

        await page.getByRole('list', { name: 'マスタ（参照されるだけ）' }).getByRole('link', { name: 'owners' }).click()
        await expect(page).toHaveURL(/\/table\/owners\/overview/)
      })
    })

    test('names an _id name of two types, and (PostgreSQL) a key of another collation than what it refers to', async ({
      page,
    }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        // A key of another collation than what it refers to: PostgreSQL takes it (MySQL refuses the key). C and POSIX
        // sort alike, but are two collations by name, which is what is compared (any other pair may not be installed).
        if (space.dialect === 'postgres') {
          await sqlOn(page, space, 'CREATE TABLE owners (code VARCHAR(10) COLLATE "C" PRIMARY KEY)')
          await sqlOn(
            page,
            space,
            'CREATE TABLE pets (id INT PRIMARY KEY, owner_code VARCHAR(10) COLLATE "POSIX", FOREIGN KEY (owner_code) REFERENCES owners (code))'
          )
        }
        await sqlOn(page, space, 'CREATE TABLE posts (id INT PRIMARY KEY, tag_id INT)')
        await sqlOn(page, space, 'CREATE TABLE notes (id INT PRIMARY KEY, tag_id BIGINT)')
        await page.goto(`/db/${space.database}/map${space.schema ? `?schema=${space.schema}` : ''}`)

        if (space.dialect === 'postgres') {
          const keys = page.getByRole('region', { name: '参照先と型が違う外部キー' })
          await expect(keys.getByRole('link')).toHaveText(
            'pets.owner_code（character varying(10)、照合順序 POSIX）→ owners.code（character varying(10)、照合順序 C）'
          )
        }
        const types = page.getByRole('list', { name: 'tag_id の型' }).getByRole('listitem')
        await expect(types).toHaveText(['bigint（notes）', 'int（posts）'])
      })
    })

    test('finds how two tables join, and opens the Query tab with the tables of the path', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await petsAndLogs(page, space)
        await sqlOn(
          page,
          space,
          'CREATE TABLE visits (id INT PRIMARY KEY, pet_id INT, FOREIGN KEY (pet_id) REFERENCES pets (id))'
        )
        await page.goto(`/db/${space.database}/map${space.schema ? `?schema=${space.schema}` : ''}`)
        const card = page.locator('section', { has: page.getByRole('heading', { name: '2 つのテーブルのつなぎ方' }) })
        await card.getByLabel('ここから').selectOption('visits')
        await card.getByLabel('ここまで').selectOption('owners')
        await expect(card.getByRole('status')).toHaveText('最短の経路は 2 段で、1 本です')
        await expect(card.getByRole('list', { name: '経路 1 の各段' }).getByRole('listitem')).toHaveText([
          'visits → pets（visits.pet_id が pets.id を参照）',
          'pets → owners（pets.owner_id が owners.id を参照）',
        ])
        // The two are kept in the address, so the path can be shared.
        await expect(page).toHaveURL(/from=visits.*to=owners/)

        await card.getByLabel('ここまで').selectOption('logs')
        await expect(card.getByRole('status')).toHaveText('visits と logs は、外部キーをたどってもつながりません')
        await card.getByLabel('ここまで').selectOption('owners')

        await card.getByRole('link', { name: '経路 1 でクエリを作る' }).click()
        await expect(page).toHaveURL(/\/query/)
        await expect(page.getByText('結合の順: visits → pets → owners')).toBeVisible()
        await page.getByRole('button', { name: 'SQL を作成' }).click()
        const generated = page.locator('pre')
        await expect(generated).toContainText('LEFT JOIN')
        await expect(generated).toContainText('owners')
      })
    })

    test('presents the map scene by scene, with the keys and a join path, and closes with Esc', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await petsAndLogs(page, space)
        // Nothing plays by itself: the scenes are moved by hand, as a presenter does.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(`/db/${space.database}/map?${space.schema ? `schema=${space.schema}&` : ''}from=pets&to=owners`)
        await page.getByRole('button', { name: 'プレゼンで見る' }).click()
        const tour = page.getByRole('dialog', { name: /^見取り図のプレゼン/ })
        const title = tour.getByRole('heading', { level: 3 })
        await expect(title).toHaveText(space.schema ?? space.database)
        await expect(tour.getByText('テーブル 3・外部キー 1 本。', { exact: false })).toBeVisible()
        // Every table of the space drawn, under the camera.
        await expect(tour.getByRole('img', { name: /のテーブルと外部キーの図$/ })).toBeVisible()

        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('マスタ（1）')
        await expect(tour.locator('[data-flow="forward"]')).toHaveCount(1)
        await page.keyboard.press('PageDown')
        await expect(title).toHaveText('記録・明細（1）')
        // Masters, details, joined to nothing, one hub; then the path: pets → owners, walked with the key.
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('pets から owners へのつなぎ方')
        await expect(tour.getByText('1 段のうち 1 段目: pets.owner_id が owners.id を参照')).toBeVisible()
        await page.keyboard.press('End')
        await expect(title).toHaveText('まとめ')

        await page.keyboard.press('Escape')
        await expect(tour).toBeHidden()
        await expect(page.getByRole('button', { name: 'プレゼンで見る' })).toBeFocused()
      })
    })
  })
}
