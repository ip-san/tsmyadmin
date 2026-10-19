import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`data dictionary (${t.dialect})`, () => {
    test('lists every table with its columns and what they reference', async ({ page }) => {
      await login(page, t)
      await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
      await page.getByRole('link', { name: 'データ辞書（全テーブルの定義を印刷用に）' }).click()
      const posts = page.getByRole('table', { name: 'posts', exact: true })
      await expect(posts.getByRole('row').filter({ hasText: 'user_id' })).toContainText('users.id')
      await expect(page.getByRole('table', { name: 'users', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '印刷' })).toBeVisible()
    })

    test('saves the dictionary as Markdown once every definition is read', async ({ page }) => {
      await login(page, t)
      await page.goto(`/db/${t.database}/dictionary${t.schema ? `?schema=${t.schema}` : ''}`)
      // Read through: the line that counts the definitions read is gone.
      await expect(page.getByRole('table', { name: 'posts', exact: true })).toBeVisible()
      await expect(page.getByText(/^テーブルの定義を読んでいます/)).toHaveCount(0)
      const save = page.getByRole('button', { name: 'Markdown で保存' })
      await expect(save).not.toHaveAttribute('aria-disabled', 'true')
      const download = page.waitForEvent('download')
      await save.click()
      const file = await download
      expect(file.suggestedFilename()).toMatch(/dictionary\.md$/)
      const md = readFileSync(await file.path(), 'utf8')
      expect(md).toMatch(/^# データ辞書: /)
      expect(md).toContain('\n## posts\n')
      expect(md).toMatch(/\| user_id \| [^|]+ \| [^|]+ \| [^|]* \| users\.id \|/)
    })
  })
}
