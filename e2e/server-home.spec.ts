import { expect } from '@playwright/test'
import { confirmPreview, lockDatabaseGrants, login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`server top page (${t.dialect})`, () => {
    lockDatabaseGrants(t.dialect)
    test('shows which server this is, and prints without its controls', async ({ page }) => {
      await login(page, t)
      await page.goto('/')
      const info = page.getByRole('region', { name: 'サーバー情報' })
      await expect(info).toContainText(`${t.host}:${t.port}`)
      await expect(info).toContainText('バージョン')
      if (t.dialect === 'mysql') await expect(info).toContainText('utf8mb4_unicode_ci')
      else await expect(info).not.toContainText('接続の照合順序')

      // On paper the checkboxes and the actions are left out, and so is the print button.
      await expect(page.getByRole('button', { name: '一覧を印刷' })).toBeVisible()
      await page.emulateMedia({ media: 'print' })
      await expect(page.getByRole('button', { name: '一覧を印刷' })).toBeHidden()
      await expect(page.getByLabel('すべて選択')).toBeHidden()
      await expect(page.getByRole('columnheader', { name: 'データベース名' })).toBeVisible()
    })

    test('leaves the sizes uncounted on request, and sorts the list by a column', async ({ page }) => {
      await login(page, t)
      await page.goto('/')
      const table = page.getByRole('table').first()
      const row = table.getByRole('row').filter({ hasText: t.database })
      await expect(row.getByRole('cell', { name: /(B|KB|MB|GB)$/ })).toBeVisible()
      await page.getByLabel('サイズとテーブル数を数える').uncheck()
      await expect(row.getByRole('cell', { name: '–' }).first()).toBeVisible()
      await expect(row.getByRole('cell', { name: /(B|KB|MB|GB)$/ })).toHaveCount(0)
      await page.getByLabel('サイズとテーブル数を数える').check()
      await expect(row.getByRole('cell', { name: /(B|KB|MB|GB)$/ })).toBeVisible()

      const name = table.getByRole('columnheader', { name: 'データベース名' })
      await name.getByRole('button').click()
      await expect(name).toHaveAttribute('aria-sort', 'ascending')
      await name.getByRole('button').click()
      await expect(name).toHaveAttribute('aria-sort', 'descending')
    })

    test('connects in the collation chosen at login (MySQL only)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'the connection collation is a MySQL / MariaDB setting')
      await page.request.post('/api/session', {
        data: {
          dialect: t.dialect,
          host: t.host,
          port: t.port,
          user: t.user,
          password: t.password,
          database: t.database,
          collation: 'utf8mb4_bin',
        },
      })
      await page.goto('/')
      await expect(page.getByRole('region', { name: 'サーバー情報' })).toContainText('utf8mb4_bin')
    })
    test('lets an account without account-management rights change its own password, then asks it to sign in again', async ({
      page,
      browser,
      baseURL,
    }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const name = `e2e_own_${Date.now().toString(36)}`
      const mysql = t.dialect === 'mysql'
      const user = mysql ? { name, host: '%' } : { name }
      const run = (op: object) => page.request.post('/api/users/execute', { data: { op } })
      const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}) })
      try {
        expect(
          (
            await run({
              op: 'createUser',
              user,
              password: 'own-pw-1',
              attributes: { superuser: false, createdb: false, createrole: false },
            })
          ).ok()
        ).toBe(true)
        // Enough to sign in with the fixture database as the login's default; no CREATE USER / CREATEROLE.
        expect(
          (
            await run({
              op: 'grantPrivileges',
              user,
              privileges: ['SELECT'],
              database: t.database,
              ...(t.schema ? { schema: t.schema } : {}),
            })
          ).ok()
        ).toBe(true)

        const own = await context.newPage()
        await login(own, { ...t, user: name, password: 'own-pw-1' })
        await own.goto('/')
        await own.getByRole('button', { name: '自分のパスワードを変更' }).click()
        await own.getByLabel('パスワード', { exact: true }).fill('own-pw-2')
        await own.getByLabel('パスワード（確認）').fill('own-pw-2')
        await own.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(own, /(ALTER USER|ALTER ROLE)[\s\S]*\*\*\*\*/)
        await expect(own.getByText('パスワードを変更しました。新しいパスワードで接続してください。')).toBeVisible()

        await login(own, { ...t, user: name, password: 'own-pw-2' }, { fromCurrentPage: true })
        await expect(own.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
      } finally {
        await context.close()
        await run({ op: 'revokeAll', user, database: t.database, ...(t.schema ? { schema: t.schema } : {}) })
        await run({ op: 'dropUser', user })
      }
    })
  })
}
