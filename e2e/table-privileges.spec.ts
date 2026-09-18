import { expect } from '@playwright/test'
import { confirmPreview, lockDatabaseGrants, login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`table privileges (${t.dialect})`, () => {
    // Grants on the fixture database: two specs doing it at once collide in PostgreSQL's catalog.
    lockDatabaseGrants(t.dialect)
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('shows each account’s privileges on the table and grants and revokes with the table preselected', async ({
      page,
    }) => {
      const name = `e2e_tpriv_${Date.now().toString(36)}`
      const key = t.dialect === 'mysql' ? `${name}@%` : name
      await page.goto('/users')
      await page.getByRole('button', { name: 'ユーザーを作成' }).click()
      await page.getByLabel('ユーザー名').fill(name)
      await page.getByLabel('パスワード', { exact: true }).fill('pw-123')
      await page.getByLabel('パスワード（確認）').fill('pw-123')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /CREATE (USER|ROLE)/)

      await page.goto(tableUrl(t, 'posts', '/privileges'))
      const grid = page.getByRole('table', { name: 'posts の権限' })
      // Header: account, (host), six privileges, actions. Cells are read by position in the header.
      await expect(grid.getByRole('columnheader', { name: 'TRIGGER' })).toBeVisible()
      const headers = await grid.getByRole('columnheader').allInnerTexts()
      const cell = (privilege: string) =>
        grid.getByRole('row').filter({ hasText: name }).getByRole('cell').nth(headers.indexOf(privilege))
      await expect(cell('SELECT')).toHaveText('–')
      // The account this session logged in with holds everything, from the server (MySQL *.*) or as superuser.
      const self = grid.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tsmyadmin', exact: true }) })
      await expect(self.getByRole('cell').nth(headers.indexOf('DELETE'))).toContainText('サーバー全体')

      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      const chooser = page.getByRole('dialog')
      await expect(chooser.getByLabel('対象')).toHaveValue('posts')
      await chooser.getByRole('button', { name: '権限を付与' }).click()
      await confirmPreview(page, /GRANT SELECT ON/)
      await expect(cell('SELECT')).toContainText('テーブル')

      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      await chooser.getByRole('checkbox', { name: /^SELECT/ }).uncheck()
      await chooser.getByRole('checkbox', { name: /^UPDATE/ }).check()
      await chooser.getByRole('checkbox', { name: 'title', exact: true }).check()
      await chooser.getByRole('button', { name: '権限を付与' }).click()
      await confirmPreview(page, /GRANT UPDATE \(.?title.?\) ON/)
      await expect(cell('UPDATE')).toContainText('カラム: title')

      // Revoke both, so PostgreSQL lets the role be dropped.
      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      await chooser.getByRole('button', { name: '権限を取り消す' }).click()
      await confirmPreview(page, /REVOKE SELECT ON/)
      await expect(cell('SELECT')).toHaveText('–')
      await page.getByRole('button', { name: `${key}: 権限を選ぶ…` }).click()
      await chooser.getByRole('checkbox', { name: /^SELECT/ }).uncheck()
      await chooser.getByRole('checkbox', { name: /^UPDATE/ }).check()
      await chooser.getByRole('checkbox', { name: 'title', exact: true }).check()
      await chooser.getByRole('button', { name: '権限を取り消す' }).click()
      await confirmPreview(page, /REVOKE UPDATE \(.?title.?\) ON/)
      await expect(cell('UPDATE')).toHaveText('–')

      if (t.dialect === 'postgres') {
        // The table grant also gave schema and database access, which must go before the role can.
        await page.goto(`/db/${t.database}/privileges${t.schema ? `?schema=${t.schema}` : ''}`)
        await page.getByRole('button', { name: `${key}: このデータベースの全権限を取り消す` }).click()
        await confirmPreview(page, /REVOKE/)
      }
      await page.goto('/users')
      await page.getByRole('button', { name: `${key}: 削除` }).click()
      await confirmPreview(page, /DROP (USER|ROLE)/, name)
      await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
    })
  })
}
