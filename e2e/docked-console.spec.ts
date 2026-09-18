import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`docked console (${t.dialect})`, () => {
    test('stays open across pages and runs against the database on screen', async ({ page }) => {
      await login(page, t)
      await page.goto(tableUrl(t, 'users'))
      const toggle = page.getByRole('button', { name: 'コンソール', exact: true })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      const dock = page.getByRole('region', { name: 'SQL コンソール（画面の下に常駐）' })
      const editor = dock.getByRole('textbox', { name: 'SQL エディタ' })
      await editor.click()
      await page.keyboard.type('SELECT COUNT(*) AS n FROM users')
      await dock.getByRole('button', { name: '実行する', exact: true }).click()
      await expect(dock.getByRole('region', { name: '文 1' })).toContainText('5')
      // Moving to another tab keeps it open, with what was typed.
      await page.goto(tableUrl(t, 'users', '/structure'))
      await expect(dock).toBeVisible()
      await expect(dock.getByRole('textbox', { name: 'SQL エディタ' })).toContainText('SELECT COUNT(*) AS n FROM users')
      // It is remembered across a reload, and closes from its own button.
      await page.reload()
      await expect(dock).toBeVisible()
      await dock.getByRole('button', { name: 'コンソールを閉じる' }).click()
      await expect(dock).toBeHidden()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await page.reload()
      await expect(page.getByRole('table', { name: 'カラム' })).toBeVisible()
      await expect(dock).toBeHidden()
    })
  })
}
