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
        await page.getByRole('button', { name: '参照を検査' }).click()
        // Two child rows name parents 7 and 8; the NULL names none.
        await expect(page.getByText('参照先なし 2')).toBeVisible({ timeout: 15_000 })
        const row = page.getByRole('table', { name: '外部キー' }).getByRole('row').filter({ hasText: orphaned.key })
        await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible()
        await page.getByRole('button', { name: '参照を検査' }).click()
        await expect(page.getByText('参照先なし 2')).toHaveCount(0)
      } finally {
        await orphaned.drop()
      }
    })
  })
}
