import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'
import { orphanedKey } from './references.ts'

for (const t of TARGETS) {
  test.describe(`designer references (${t.dialect})`, () => {
    test('counts the rows whose parent is missing, on the line and in the table of keys', async ({ page }) => {
      await login(page, t)
      const orphaned = await orphanedKey(page, t)
      try {
        await page.goto(`/db/${t.database}/designer${t.schema ? `?schema=${t.schema}` : ''}`)
        const check = page.getByRole('button', { name: '参照を検査' })
        await check.click()
        await expect(check).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByRole('status').filter({ hasText: /表を検査しました$/ })).toBeVisible({ timeout: 15_000 })
        // Two child rows name parents 7 and 8; the NULL names none. This key's own row says so; the badge on its
        // line says the same (another test's orphaned key may be drawn too, with a badge of its own).
        const row = page.getByRole('table', { name: '外部キー' }).getByRole('row').filter({ hasText: orphaned.key })
        await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible()
        await expect(page.getByText('参照先なし 2').first()).toBeVisible()
        await check.click()
        await expect(check).toHaveAttribute('aria-pressed', 'false')
        await expect(page.getByRole('columnheader', { name: '参照先が無い行' })).toHaveCount(0)
      } finally {
        await orphaned.drop()
      }
    })
  })
}
