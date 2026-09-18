import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const exportUrl = `/db/${t.database}/export${t.schema ? `?schema=${t.schema}` : ''}`

  test.describe(`export templates (${t.dialect})`, () => {
    test('saves the current choices under a name and puts them back', async ({ page }) => {
      await login(page, t)
      await page.goto(exportUrl)
      const panel = page.locator('summary').filter({ hasText: 'エクスポートのテンプレート' })
      await panel.click()

      // CSV of one table, without the structure: none of it is the default the page opens with.
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('radio', { name: 'CSV' }).check()
      await page.getByLabel('BOM を付ける', { exact: false }).uncheck()
      await page.getByLabel('テンプレート名').fill('nightly')
      await page.getByRole('button', { name: '保存する', exact: true }).click()

      const entry = page.getByRole('listitem').filter({ hasText: 'nightly' })
      await expect(entry).toContainText('CSV')
      await expect(entry).toContainText('1 テーブル')

      // Change everything, then load the template back.
      await page.getByRole('radio', { name: 'SQL' }).check()
      await page.getByRole('checkbox', { name: 'users', exact: true }).uncheck()
      await page.getByRole('checkbox', { name: 'posts', exact: true }).check()
      await entry.getByRole('button', { name: '読み込む' }).click()
      await expect(page.getByRole('radio', { name: 'CSV' })).toBeChecked()
      await expect(page.getByRole('checkbox', { name: 'users', exact: true })).toBeChecked()
      await expect(page.getByRole('checkbox', { name: 'posts', exact: true })).not.toBeChecked()
      await expect(page.getByLabel('BOM を付ける', { exact: false })).not.toBeChecked()

      // The list survives a reload (this deployment keeps it in the browser), and the row can be deleted.
      await page.reload()
      await panel.click()
      await expect(page.getByRole('listitem').filter({ hasText: 'nightly' })).toBeVisible()
      await page.getByRole('button', { name: 'テンプレート nightly を削除' }).click()
      await expect(page.getByRole('listitem').filter({ hasText: 'nightly' })).toHaveCount(0)
    })
  })
}
