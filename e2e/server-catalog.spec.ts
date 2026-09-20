import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

/** What each tab is called on each server, and one entry every such server lists. */
const EXPECT = {
  mysql: [
    { tab: '文字セット・照合順序', entry: 'utf8mb4_bin' },
    { tab: 'エンジン', entry: 'InnoDB' },
    { tab: 'プラグイン', entry: 'InnoDB' },
  ],
  postgres: [
    { tab: '照合順序', entry: 'C' },
    { tab: 'アクセスメソッド', entry: 'btree' },
    { tab: '拡張', entry: 'plpgsql' },
  ],
}

for (const t of TARGETS) {
  test.describe(`server catalog (${t.dialect})`, () => {
    test('shows collations, engines and plugins under the names the server uses, with a filter', async ({ page }) => {
      await login(page, t)
      for (const { tab, entry } of EXPECT[t.dialect]) {
        await page.getByRole('navigation', { name: 'サーバー' }).getByRole('link', { name: tab, exact: true }).click()
        await expect(page.getByRole('heading', { name: tab, exact: true })).toBeVisible()
        await page.getByLabel('絞り込む（どの列でも）').fill(entry)
        await expect(page.getByRole('cell', { name: entry, exact: true }).first()).toBeVisible()
      }
    })

    test("opens an engine's own variables (MySQL)", async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'PostgreSQL has no storage engines')
      await login(page, t)
      await page.goto('/engines')
      await page.getByRole('button', { name: 'InnoDB: 変数を表示' }).click()
      const variables = page.getByRole('table', { name: 'InnoDB の変数' })
      await expect(variables.getByRole('cell', { name: 'innodb_buffer_pool_size', exact: true })).toBeVisible()
    })

    test('shows the replication role and the binary logs / WAL segments', async ({ page }) => {
      await login(page, t)
      await page
        .getByRole('navigation', { name: 'サーバー' })
        .getByRole('link', { name: 'レプリケーション', exact: true })
        .click()
      await expect(page.getByText('このサーバーの役割')).toBeVisible()
      await expect(page.getByText('単独', { exact: true })).toBeVisible()
      const logs = page.getByRole('table', { name: t.dialect === 'mysql' ? 'バイナリログ' : 'WAL セグメント' })
      await expect(logs.getByRole('row').nth(1)).toBeVisible()
    })
  })
}
