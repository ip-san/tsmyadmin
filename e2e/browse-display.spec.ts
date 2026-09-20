import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`browse display (${t.dialect})`, () => {
    test('columns in a remembered order, full texts, binary as hex, a BLOB downloaded whole', async ({ page }) => {
      await login(page, t)
      const table = `e2e_disp_${Date.now().toString(36)}`
      const blob = t.dialect === 'mysql' ? 'MEDIUMBLOB' : 'BYTEA'
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, note TEXT, b ${blob})`)
      const bytes = t.dialect === 'mysql' ? `REPEAT('a', 70000)` : `decode(repeat('61', 70000), 'hex')`
      await sql(page, t, `INSERT INTO ${table} VALUES (1, '${'long text '.repeat(40)}', ${bytes})`)
      try {
        await page.goto(tableUrl(t, table))
        await page.getByText('全 1 行').waitFor()
        const grid = page.getByRole('table', { name: table })

        // Move `b` before `note`; the order survives leaving and coming back to the table.
        await page
          .getByRole('button', { name: /カラム/ })
          .first()
          .click()
        await page.getByRole('button', { name: 'b を左へ' }).click()
        await expect(grid.getByRole('columnheader').nth(2)).toContainText('b')
        await page.goto(tableUrl(t, table))
        await expect(grid.getByRole('columnheader').nth(2)).toContainText('b')

        // Display options: long texts whole, binary as hex.
        await expect(grid.getByRole('button', { name: /全文を表示/ })).toBeVisible()
        await page.locator('summary', { hasText: '表示のしかた' }).click()
        await page.getByLabel('長い値を全文で表示').check()
        await page.getByLabel('バイナリを 16 進で表示').check()
        await expect(grid.getByRole('button', { name: '折りたたむ' })).toBeVisible()
        await expect(grid.getByText(/^0x6161/)).toBeVisible()
        await expect(grid.getByText('…（全 65,536 バイト）')).toBeVisible()

        // The page holds 64 KB of the value; the download has all of it.
        const download = page.waitForEvent('download')
        await grid.getByRole('link', { name: 'b の値をダウンロード' }).click()
        const file = readFileSync(await (await download).path())
        expect(file.length).toBe(70000)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('shows a spatial value as WKT', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'PostgreSQL spatial values without PostGIS already arrive as text')
      await login(page, t)
      const table = `e2e_wkt_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, g GEOMETRY)`)
      await sql(page, t, `INSERT INTO ${table} VALUES (1, ST_GeomFromText('MULTIPOINT((1 2),(3 4))'))`)
      try {
        await page.goto(tableUrl(t, table))
        await page.getByText('全 1 行').waitFor()
        await page.locator('summary', { hasText: '表示のしかた' }).click()
        await page.getByLabel('空間データを WKT で表示').check()
        await expect(page.getByRole('table', { name: table }).getByText('MULTIPOINT((1 2), (3 4))')).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}

for (const t of TARGETS) {
  test(`a row under the pointer is highlighted (${t.dialect})`, async ({ page }) => {
    await login(page, t)
    await page.goto(tableUrl(t, 'users'))
    await page.getByRole('table', { name: 'users' }).getByRole('row').nth(1).waitFor()
    const row = page.getByRole('table', { name: 'users' }).getByRole('row').nth(2)
    const background = () => row.evaluate((el) => getComputedStyle(el).backgroundColor)
    await page.mouse.move(0, 0)
    const before = await background()
    await row.hover()
    // The row-hover colour of the theme, not the (transparent) resting one.
    await expect.poll(background).not.toBe(before)
  })
}
