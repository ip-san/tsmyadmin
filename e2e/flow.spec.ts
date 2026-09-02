import { expect, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

test.describe('login', () => {
  test('logs in through an operator-defined preset with only user and password', async ({ page }) => {
    const t = TARGETS[1]
    if (!t) throw new Error('no targets')
    await page.goto('/login')
    await page.getByLabel('接続先').selectOption('e2e-postgres')
    await expect(page.getByLabel('ホスト')).toHaveValue(t.host)
    await expect(page.getByLabel('ホスト')).toHaveAttribute('readonly', '')
    await page.getByLabel('ユーザー名').fill(t.user)
    await page.getByLabel('パスワード').fill(t.password)
    await page.getByRole('button', { name: '接続' }).click()
    await expect(page.getByRole('heading', { name: 'サーバー' })).toBeVisible()
    await expect(page.getByText('PostgreSQL')).toBeVisible()
  })

  test('shows an error for wrong credentials and stays on the form', async ({ page }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no targets')
    await page.goto('/login')
    await page.getByLabel('接続先').selectOption('')
    await page.getByLabel('サーバー種別').selectOption(t.dialect)
    await page.getByLabel('ホスト').fill(t.host)
    await page.getByLabel('ポート').fill(String(t.port))
    await page.getByLabel('ユーザー名').fill(t.user)
    await page.getByLabel('パスワード').fill('definitely-wrong')
    await page.getByRole('button', { name: '接続' }).click()
    await expect(page.getByRole('alert')).toContainText('認証に失敗しました')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('serves the SPA with a Content-Security-Policy and still boots under it', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const res = await page.goto('/login')
    expect(res?.headers()['content-security-policy']).toContain("script-src 'self'")
    await expect(page.getByLabel('ホスト')).toBeVisible()
    expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([])
  })

  test('redirects unauthenticated visitors to /login and returns them to the deep link after login', async ({
    page,
  }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no target')
    await page.goto('/db/tsmyadmin_test/table/users?limit=25')
    await expect(page).toHaveURL(/\/login\?redirect=/)
    await login(page, t, { fromCurrentPage: true })
    await expect(page).toHaveURL(/\/db\/tsmyadmin_test\/table\/users\?limit=25/)
    await expect(page.getByRole('table', { name: 'users' })).toBeVisible()
  })

  test('ignores off-site redirect targets', async ({ page }) => {
    await page.goto('/login?redirect=https%3A%2F%2Fevil.example%2F')
    await expect(page.getByLabel('ホスト')).toBeVisible()
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

    test('keyboard shortcuts: help dialog, sidebar search focus, page navigation', async ({ page }) => {
      await page.goto(`${tableUrl(t, 'users')}${t.schema ? '&' : '?'}limit=2&sort=id:asc`)
      await expect(page.getByText('全 5 件')).toBeVisible()
      await page.keyboard.press('Shift+?')
      await expect(page.getByRole('dialog', { name: 'キーボードショートカット' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'キーボードショートカット' })).toBeHidden()
      await page.keyboard.press('ControlOrMeta+K')
      await expect(page.getByLabel('テーブルを絞り込む')).toBeFocused()
      await page.keyboard.press('Escape')
      await page.locator('main').click()
      await page.keyboard.press('ArrowRight')
      await expect(page).toHaveURL(/page=2/)
      await expect(page.getByRole('cell', { name: 'Carol', exact: true })).toBeVisible()
      await page.keyboard.press('ArrowLeft')
      await expect(page).toHaveURL(/page=1/)
      // Sidebar toggle (button and mod+B) persists across reloads.
      await page.getByRole('button', { name: 'サイドバーを隠す' }).click()
      await expect(page.getByRole('complementary')).toBeHidden()
      await page.reload()
      await expect(page.getByRole('complementary')).toBeHidden()
      await page.locator('main').click()
      await page.keyboard.press('ControlOrMeta+B')
      await expect(page.getByRole('complementary')).toBeVisible()
    })

    test('column picker hides columns and keeps the choice in the URL', async ({ page }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByRole('button', { name: '列 5/5' }).click()
      await page.getByRole('group', { name: '列' }).getByLabel('email').uncheck()
      await expect(page).toHaveURL(/cols=/)
      await expect(page.getByRole('button', { name: '列 4/5' })).toBeVisible()
      await expect(page.getByRole('columnheader').filter({ hasText: 'email' })).toHaveCount(0)
      await expect(page.getByRole('cell', { name: 'Alice', exact: true })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('button', { name: '列 4/5' })).toBeVisible()
    })

    test('reverse references: structure lists them and rows link to referencing rows', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/structure'))
      await expect(page.getByRole('table', { name: '参照元（このテーブルを参照する外部キー）' })).toContainText(
        'fk_posts_user'
      )
      await page.goto(`${tableUrl(t, 'users')}${t.schema ? '&' : '?'}sort=id:asc`)
      await page.getByRole('link', { name: 'posts.user_id からの参照行を表示' }).first().click()
      await expect(page).toHaveURL(/\/table\/posts/)
      await expect(page.getByText('全 2 件')).toBeVisible()
    })

    test('foreign-key cells link to the referenced row', async ({ page }) => {
      await page.goto(tableUrl(t, 'posts'))
      const link = page.getByRole('link', { name: 'users.id を参照' }).first()
      await expect(link).toBeVisible()
      await link.click()
      await expect(page).toHaveURL(/\/table\/users/)
      await expect(page.getByText('全 1 件')).toBeVisible()
      await expect(page.getByRole('cell', { name: 'Alice', exact: true })).toBeVisible()
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
