import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`gis view (${t.dialect})`, () => {
    test('draws the spatial values of the page, labelled by another column', async ({ page }) => {
      await login(page, t)
      const table = `e2e_gis_${Date.now().toString(36)}`
      if (t.dialect === 'mysql') {
        await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(10), shape GEOMETRY)`)
        await sql(
          page,
          t,
          `INSERT INTO ${table} VALUES (1, 'spot', ST_GeomFromText('POINT(1 1)')), ` +
            `(2, 'field', ST_GeomFromText('POLYGON((0 0, 4 0, 4 3, 0 0))')), (3, 'none', NULL)`
        )
      } else {
        await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(10), shape POLYGON, spot POINT)`)
        await sql(
          page,
          t,
          `INSERT INTO ${table} VALUES (1, 'spot', '((0,0),(1,0),(1,1))', '(1,1)'), ` +
            `(2, 'field', '((0,0),(4,0),(4,3))', '(2,2)'), (3, 'none', NULL, NULL)`
        )
      }
      try {
        await page.goto(tableUrl(t, table))
        await page.getByText('全 3 行').waitFor()
        await page.getByText('図形で表示（GIS）').click()
        await expect(page.getByText('2 件の図形', { exact: true })).toBeVisible()
        const picture = page.getByRole('img', { name: 'shape の図形 2 件' })
        await expect(picture.locator('g')).toHaveCount(2)
        await page.getByLabel('ラベル').selectOption('name')
        await expect(picture.locator('title')).toHaveText(['spot', 'field'])
        if (t.dialect === 'postgres') {
          // A second spatial column can be chosen instead.
          await page.getByLabel('空間カラム').selectOption('spot')
          await expect(page.getByRole('img', { name: 'spot の図形 2 件' }).locator('circle')).toHaveCount(2)
        }
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
