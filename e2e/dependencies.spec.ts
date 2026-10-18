import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, tableUrl, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`dependencies (${t.dialect})`, () => {
    test('draws which views use which tables, and what a change to a table reaches', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        // recent reads active, which reads members; lone is used by nothing.
        await sqlOn(page, space, 'CREATE TABLE members (id INT PRIMARY KEY, active INT)')
        await sqlOn(page, space, 'CREATE TABLE lone (id INT PRIMARY KEY)')
        await sqlOn(page, space, 'CREATE VIEW active AS SELECT id FROM members WHERE active = 1')
        await sqlOn(page, space, 'CREATE VIEW recent AS SELECT id FROM active')
        await page.goto(`/db/${space.database}/dependencies${space.schema ? `?schema=${space.schema}` : ''}`)
        await expect(page.getByRole('img', { name: /^依存関係の図/ })).toBeVisible()
        const words = page.getByRole('list', { name: '依存関係の一覧' })
        await expect(words).toContainText('ビュー recent は ビュー active を使います')
        await expect(words).toContainText('ビュー active は 表 members を使います')

        await page.getByLabel('変えるもの').selectOption({ label: '表 members' })
        await expect(page.getByRole('status').filter({ hasText: /^表 members を変えると/ })).toHaveText(
          '表 members を変えると、ビュー active、ビュー recent に影響します（直接・間接）'
        )

        // The same from the table's structure, with the way to the whole diagram.
        await page.goto(tableUrl(space, 'members', '/structure'))
        const usedBy = page.locator('section', { has: page.getByRole('heading', { name: 'この表を使うもの' }) })
        await expect(usedBy.getByRole('listitem')).toHaveText(['ビュー active', 'ビュー recent'])
        await page.goto(tableUrl(space, 'lone', '/structure'))
        await expect(page.getByText('この表を使うビュー・ルーチン・トリガーはありません')).toBeVisible()
      })
    })
  })
}
