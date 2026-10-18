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
  })
}
