import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  await page.request
    .post(`/api/databases/${t.database}/sql`, { data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) } })
    .catch(() => undefined)
}

const designerUrl = (t: Target) =>
  t.schema ? `/db/${t.database}/designer?schema=${t.schema}` : `/db/${t.database}/designer`

for (const t of TARGETS) {
  test.describe(`designer actions (${t.dialect})`, () => {
    test('makes a key by picking two columns on the diagram, then deletes it from the list', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const parent = `e2e_rp_${suffix}`
      const child = `e2e_rc_${suffix}`
      await sql(page, t, `CREATE TABLE ${parent} (id INT PRIMARY KEY, label VARCHAR(20))`)
      await sql(page, t, `CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id INT)`)
      try {
        await page.goto(designerUrl(t))
        await page.getByRole('button', { name: '図で外部キーを作る' }).click()
        await page.getByRole('button', { name: `${child} の parent_id` }).click()
        await expect(page.locator('p[role="status"]')).toContainText(`${child}.parent_id`)
        await page.getByRole('button', { name: `${parent} の id` }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByLabel('参照先テーブル')).toHaveValue(parent)
        await dialog
          .getByRole('button', { name: /確認|SQL/ })
          .last()
          .click()
        await confirmPreview(page, new RegExp(`FOREIGN KEY[\\s\\S]*${parent}`))
        const keys = page.getByRole('table', { name: '外部キー' })
        await expect(keys.getByRole('cell', { name: child, exact: true })).toBeVisible()

        await page.getByRole('button', { name: new RegExp(`${child} の外部キー .* を削除`) }).click()
        await confirmPreview(page, /DROP (FOREIGN KEY|CONSTRAINT)/)
        await expect(keys.getByRole('cell', { name: child, exact: true })).toHaveCount(0)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${child}`)
        await sql(page, t, `DROP TABLE IF EXISTS ${parent}`)
      }
    })

    test('lists every column, marks the display column, saves a page and exports SVG', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const parent = `e2e_dp_${suffix}`
      const child = `e2e_dc_${suffix}`
      await sql(page, t, `CREATE TABLE ${parent} (id INT PRIMARY KEY, label VARCHAR(20), extra INT)`)
      await sql(page, t, `CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id INT)`)
      await sql(
        page,
        t,
        `ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (parent_id) REFERENCES ${parent} (id)`
      )
      try {
        await page.goto(designerUrl(t))
        // Only the columns a key uses, until asked.
        await expect(page.getByRole('button', { name: `テーブル ${parent}（矢印キーで移動）` })).toBeVisible()
        await expect(page.getByText('label', { exact: true })).toHaveCount(0)
        await page.getByLabel('全カラムを表示').check()
        await expect(page.getByText('extra', { exact: true }).first()).toBeVisible()

        const item = page.getByRole('listitem').filter({ hasText: parent })
        await item.getByRole('combobox').selectOption('label')
        await expect(page.getByText('◆ label')).toBeVisible()

        // A page: the layout kept under a name, and put back after moving a box.
        const panel = page.getByText(/^保存したページ/)
        await panel.click()
        await page.getByLabel('ページ名').fill('overview')
        await page.getByRole('button', { name: '保存する', exact: true }).click()
        await expect(page.getByText('overview').first()).toBeVisible()

        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: 'SVG で保存' }).click()
        const file = await download
        expect(file.suggestedFilename()).toMatch(/designer\.svg$/)
        const body = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8')
        expect(body).toContain('<svg')
        expect(body).toContain('◆ label')
        expect(body).toContain(parent)

        await page.getByRole('button', { name: 'overview を削除' }).click()
        await expect(page.getByText('このデータベースで保存したページはありません')).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${child}`)
        await sql(page, t, `DROP TABLE IF EXISTS ${parent}`)
      }
    })
  })
}
