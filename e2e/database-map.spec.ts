import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`database map (${t.dialect})`, () => {
    test('sorts the tables by role and names what to look at', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await sqlOn(page, space, 'CREATE TABLE owners (id INT PRIMARY KEY, name VARCHAR(20))')
        await sqlOn(
          page,
          space,
          'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))'
        )
        await sqlOn(page, space, 'CREATE TABLE logs (message VARCHAR(20))')
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
  })
}
