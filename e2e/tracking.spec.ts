import { expect, type Page } from '@playwright/test'
import { login, PERSISTENT_BASE_URL, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`change tracking (${t.dialect})`, () => {
    // Versions are kept by the session store, so only a persistent one offers the tab.
    test.use({ baseURL: PERSISTENT_BASE_URL })

    test('records versions of the definition and shows what changed between them', async ({ page }) => {
      await login(page, t)
      const table = `e2e_track_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20))`)
      try {
        await page.goto(tableUrl(t, table, '/tracking'))
        await page.getByRole('button', { name: /追跡を始める/ }).click()
        await expect(page.getByText('バージョン 1 から変わっていません')).toBeVisible()
        await expect(page.getByRole('button', { name: '現在の構造を記録' })).toBeDisabled()

        // Changed outside this page: it still shows as a difference from the latest version.
        await sql(page, t, `ALTER TABLE ${table} ADD COLUMN note VARCHAR(50)`)
        await page.reload()
        await expect(page.getByText('バージョン 1 から変わっています')).toBeVisible()
        const diff = page.getByLabel(/違い（/)
        await expect(diff).toContainText('+ ')
        await expect(diff.locator('div').filter({ hasText: /^\+ .*note/ })).toHaveCount(1)

        await page.getByRole('button', { name: '現在の構造を記録' }).click()
        await expect(page.getByText('バージョン 2 から変わっていません')).toBeVisible()
        await expect(page.getByRole('table', { name: 'バージョン' }).getByRole('row')).toHaveCount(3)
        // Comparing version 1 with version 2 shows the same change.
        await page.getByLabel('比較先').selectOption('2')
        await page.getByLabel('比較元').selectOption('1')
        await expect(
          page
            .getByLabel(/違い（/)
            .locator('div')
            .filter({ hasText: /^\+ .*note/ })
        ).toHaveCount(1)

        await page.getByRole('button', { name: '追跡をやめる…' }).click()
        await page.getByRole('dialog').getByRole('button', { name: '追跡をやめる' }).click()
        await expect(page.getByText('このテーブルは追跡していません。')).toBeVisible()
      } finally {
        await page.request.delete(
          `/api/databases/${t.database}/tables/${table}/tracking${t.schema ? `?schema=${t.schema}` : ''}`
        )
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('records the statements chosen, grid edits without values, and lists the tracked tables', async ({ page }) => {
      await login(page, t)
      const table = `e2e_trks_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20))`)
      await sql(page, t, `INSERT INTO ${table} VALUES (1, 'a')`)
      try {
        await page.goto(tableUrl(t, table, '/tracking'))
        await page.getByRole('button', { name: /追跡を始める/ }).click()
        // Definition changes by default; row changes once ticked.
        await expect(page.getByLabel('ALTER TABLE', { exact: true })).toBeChecked()
        await expect(page.getByLabel('UPDATE', { exact: true })).not.toBeChecked()
        await page.getByLabel('UPDATE', { exact: true }).check()
        await page.getByRole('button', { name: '種類を保存' }).click()
        await expect(page.getByRole('button', { name: '種類を保存' })).toBeDisabled()

        await sql(page, t, `ALTER TABLE ${table} ADD COLUMN note VARCHAR(50)`)
        await sql(page, t, `DELETE FROM ${table} WHERE id = 99`)
        await page.goto(tableUrl(t, table))
        await page.getByRole('table', { name: table }).getByRole('cell', { name: 'a', exact: true }).dblclick()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('secret')
        await page.keyboard.press('Enter')
        await expect(
          page.getByRole('table', { name: table }).getByRole('cell', { name: 'secret', exact: true })
        ).toBeVisible()

        await page.goto(tableUrl(t, table, '/tracking'))
        const log = page.getByRole('table', { name: '記録された文' })
        await expect(log.getByRole('row')).toHaveCount(3)
        await expect(log).toContainText(`ADD COLUMN note`)
        await expect(log).toContainText('表の編集: 1 行（name）')
        await expect(log).not.toContainText('secret')
        // DELETE was not chosen: not recorded.
        await expect(log).not.toContainText('DELETE')

        await page.goto(t.schema ? `/db/${t.database}/tracking?schema=${t.schema}` : `/db/${t.database}/tracking`)
        await expect(
          page.getByRole('table', { name: '追跡しているテーブル' }).getByRole('link', { name: table })
        ).toBeVisible()
      } finally {
        await page.request.delete(
          `/api/databases/${t.database}/tables/${table}/tracking${t.schema ? `?schema=${t.schema}` : ''}`
        )
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
