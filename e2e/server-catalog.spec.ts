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
  })
}
