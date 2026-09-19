import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`server databases (${t.dialect})`, () => {
    test('creates a database with a collation, then drops two at once', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const first = `e2e_sd1_${suffix}`
      const second = `e2e_sd2_${suffix}`
      const collation = t.dialect === 'mysql' ? 'utf8mb4_bin' : 'C'
      const dropQuietly = async (name: string) =>
        page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql: `DROP DATABASE IF EXISTS ${name}${t.dialect === 'postgres' ? ' WITH (FORCE)' : ''}` },
        })
      try {
        await page.request.post(`/api/databases/${t.database}/sql`, { data: { sql: `CREATE DATABASE ${second}` } })
        await page.goto('/')
        const form = page.getByRole('form', { name: 'データベースを作成' })
        await form.getByLabel('データベース名').fill(first)
        await form.getByLabel('照合順序').fill(collation)
        await form.getByRole('button', { name: 'データベースを作成' }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /COLLATE utf8mb4_bin/ : /LC_COLLATE 'C'/)
        await expect(page).toHaveURL(new RegExp(`/db/${first}$`))

        await page.goto('/')
        await page.getByLabel(`${first} を選択`).check()
        await page.getByLabel(`${second} を選択`).check()
        await expect(page.getByText('2 件のデータベースを選択中')).toBeVisible()
        await page.getByRole('button', { name: '選択したデータベースを削除…' }).click()
        await confirmPreview(page, /DROP DATABASE[\s\S]*DROP DATABASE/, t.host)
        await expect(page.getByRole('link', { name: first, exact: true }).first()).toHaveCount(0)
        await expect(page.getByRole('link', { name: second, exact: true }).first()).toHaveCount(0)
      } finally {
        await dropQuietly(first)
        await dropQuietly(second)
      }
    })
  })
}
