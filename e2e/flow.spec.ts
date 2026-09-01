import { expect, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

test.describe('login', () => {
  test('shows an error for wrong credentials and stays on the form', async ({ page }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no targets')
    await page.goto('/login')
    await page.getByLabel('サーバー種別').selectOption(t.dialect)
    await page.getByLabel('ホスト').fill(t.host)
    await page.getByLabel('ポート').fill(String(t.port))
    await page.getByLabel('ユーザー名').fill(t.user)
    await page.getByLabel('パスワード').fill('definitely-wrong')
    await page.getByRole('button', { name: '接続' }).click()
    await expect(page.getByRole('alert')).toContainText('認証に失敗しました')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('redirects unauthenticated visitors to /login', async ({ page }) => {
    await page.goto('/db/tsmyadmin_test')
    await expect(page).toHaveURL(/\/login$/)
  })
})

for (const t of TARGETS) {
  test.describe(`browse (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('lists databases and tables, then browses rows with sort and paging', async ({ page }) => {
      await expect(page.getByRole('link', { name: t.database, exact: true }).first()).toBeVisible()
      await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
      const table = page.getByRole('table')
      await expect(table.getByRole('link', { name: 'users', exact: true })).toBeVisible()
      await expect(table.getByRole('row').filter({ hasText: 'active_users' })).toContainText('ビュー')

      await page.goto(tableUrl(t, 'users'))
      await expect(page.getByText('全 5 件')).toBeVisible()
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(6)
      await expect(page.getByRole('cell', { name: 'Alice', exact: true })).toBeVisible()

      await page.getByRole('button', { name: 'name', exact: true }).click()
      await expect(page).toHaveURL(/sort=name%3Aasc|sort=name:asc/)
      await page.getByRole('button', { name: 'name', exact: true }).click()
      await expect(page).toHaveURL(/sort=name%3Adesc|sort=name:desc/)
      const firstDataRow = page.getByRole('table').getByRole('row').nth(1)
      await expect(firstDataRow).toContainText('Eve')

      await page.getByLabel('表示件数').selectOption('25')
      await expect(page).toHaveURL(/limit=25/)
      await expect(page.getByRole('button', { name: '次へ' })).toBeDisabled()
    })

    test('renders lossless values and NULLs', async ({ page }) => {
      await page.goto(tableUrl(t, 'types_all'))
      const grid = page.getByRole('table')
      await expect(grid.getByRole('cell', { name: '9223372036854775807' })).toBeVisible()
      await expect(grid.getByRole('cell', { name: '12345678901234.567891' })).toBeVisible()
      await expect(grid.getByText('NULL').first()).toBeVisible()
      await expect(grid.getByText(/バイナリ 4 bytes/).first()).toBeVisible()
    })

    test('shows table structure with keys, indexes and foreign keys', async ({ page }) => {
      await page.goto(tableUrl(t, 'posts', '/structure'))
      const columns = page.getByRole('table', { name: 'カラム' })
      await expect(columns.getByRole('row').filter({ hasText: 'user_id' })).toBeVisible()
      const pkRow = columns.getByRole('row').filter({ hasText: '主キー' })
      await expect(pkRow).toHaveCount(1)
      await expect(pkRow.getByRole('cell').nth(1)).toHaveText(/^id/)
      const fks = page.getByRole('table', { name: '外部キー' })
      await expect(fks.getByRole('row').filter({ hasText: 'fk_posts_user' })).toContainText('CASCADE')
    })

    test('logs out', async ({ page }) => {
      await page.getByRole('button', { name: '切断' }).click()
      await expect(page).toHaveURL(/\/login$/)
      await page.goto('/')
      await expect(page).toHaveURL(/\/login$/)
    })
  })
}
