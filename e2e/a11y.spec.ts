import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { login, TARGETS, tableUrl } from './helpers.ts'

const t = TARGETS[0]
if (!t) throw new Error('no targets')

async function scan(page: Parameters<typeof login>[0]) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
}

test.describe('accessibility (axe-core)', () => {
  test('login form', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('ホスト').waitFor()
    await scan(page)
  })

  test('server, database, browse and structure screens', async ({ page }) => {
    await login(page, t)
    await scan(page)
    await page.goto(`/db/${t.database}`)
    await page.getByRole('link', { name: 'users', exact: true }).first().waitFor()
    await scan(page)
    await page.goto(tableUrl(t, 'users'))
    await page.getByText('全 5 件').waitFor()
    await scan(page)
    await page.goto(tableUrl(t, 'users', '/structure'))
    await page.getByRole('table', { name: 'カラム' }).waitFor()
    await scan(page)
  })

  test('server status, processes and users screens', async ({ page }) => {
    await login(page, t)
    await page.goto('/status')
    await page.getByRole('table', { name: 'ステータス変数' }).waitFor()
    await scan(page)
    await page.goto('/processes')
    await page.getByRole('table', { name: 'プロセス一覧' }).waitFor()
    await scan(page)
    await page.goto('/users')
    await page.getByRole('cell', { name: 'tsmyadmin', exact: true }).waitFor()
    await scan(page)
    await page.goto(`/db/${t.database}/export`)
    await page.getByRole('link', { name: 'ダウンロード' }).waitFor()
    await scan(page)
  })
})
