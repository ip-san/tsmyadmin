import { expect } from '@playwright/test'
import { confirmPreview, lockDatabaseGrants, login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`an account's database privileges (${t.dialect})`, () => {
    lockDatabaseGrants(t.dialect)

    test('lists a table grant with its grant option, and revokes it from the row', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const name = `e2e_dbp_${Date.now().toString(36)}`
      const mysql = t.dialect === 'mysql'
      const user = mysql ? { name, host: '%' } : { name }
      const run = (op: object) => page.request.post('/api/users/execute', { data: { op } })
      try {
        expect(
          (
            await run({
              op: 'createUser',
              user,
              password: 'dbp-pw-1',
              attributes: { superuser: false, createdb: false, createrole: false },
            })
          ).ok()
        ).toBe(true)
        expect(
          (
            await run({
              op: 'grantPrivileges',
              user,
              privileges: ['SELECT'],
              database: t.database,
              ...(t.schema ? { schema: t.schema } : {}),
              table: 'users',
              grantOption: true,
            })
          ).ok()
        ).toBe(true)

        await page.goto('/users')
        const key = mysql ? `${name}@%` : name
        await page.getByRole('button', { name: `${key}: 権限を表示` }).click()
        const panel = page.getByRole('table', { name: `${key}: データベースごとの権限` })
        const row = panel.getByRole('row').filter({ hasText: 'users' }).filter({ hasText: 'SELECT' })
        await expect(row).toBeVisible()
        await expect(row.getByRole('cell', { name: 'はい' })).toBeVisible()
        await expect(row.getByRole('link', { name: /編集/ })).toBeVisible()

        await row.getByRole('button', { name: /取り消す/ }).click()
        await confirmPreview(page, /REVOKE SELECT/)
        await expect(row).toHaveCount(0)
      } finally {
        await run({ op: 'revokeAll', user, database: t.database, ...(t.schema ? { schema: t.schema } : {}) })
        await run({ op: 'dropUser', user })
      }
    })
  })
}
