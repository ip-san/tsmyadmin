import { readFile } from 'node:fs/promises'
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
        // The picture as files: a standalone SVG (colours written in, labels as tooltips) and a PNG.
        const [svg] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'SVG で保存' }).click(),
        ])
        expect(svg.suggestedFilename()).toMatch(/\.svg$/)
        const svgText = await readFile(await svg.path(), 'utf8')
        expect(svgText).toContain('xmlns="http://www.w3.org/2000/svg"')
        expect(svgText).toContain('<title>field</title>')
        expect(svgText).not.toContain('class=')
        const [png] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'PNG で保存' }).click(),
        ])
        expect(png.suggestedFilename()).toMatch(/\.png$/)
        expect((await readFile(await png.path())).subarray(1, 4).toString('latin1')).toBe('PNG')
        if (t.dialect === 'postgres') {
          // A second spatial column can be chosen instead.
          await page.getByLabel('空間カラム').selectOption('spot')
          await expect(page.getByRole('img', { name: 'spot の図形 2 件' }).locator('circle')).toHaveCount(2)
        }
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('keeps a whole-world rectangle out of the frame, loads a value cut at 64 KB, and zooms', async ({ page }) => {
      await login(page, t)
      const table = `e2e_gisfit_${Date.now().toString(36)}`
      const ring = Array.from({ length: 5000 }, (_, i) => {
        const a = (i / 5000) * 2 * Math.PI
        return [(127 + 0.5 * Math.cos(a)).toFixed(6), (26 + 0.5 * Math.sin(a)).toFixed(6)]
      })
      const closed = [...ring, ring[0] as string[]]
      const mysql = t.dialect === 'mysql'
      const square = (x: number, y: number, n: number) =>
        mysql
          ? `ST_GeomFromText('POLYGON((${x} ${y}, ${x + n} ${y}, ${x + n} ${y + n}, ${x} ${y}))')`
          : `'((${x},${y}),(${x + n},${y}),(${x + n},${y + n}))'`
      const big = mysql
        ? `ST_GeomFromText('POLYGON((${closed.map(([x, y]) => `${x} ${y}`).join(',')}))')`
        : `'(${ring.map(([x, y]) => `(${x},${y})`).join(',')})'`
      await sql(
        page,
        t,
        `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20), shape ${mysql ? 'GEOMETRY' : 'POLYGON'})`
      )
      await sql(
        page,
        t,
        `INSERT INTO ${table} VALUES (1, 'world', ${square(-180, -90, 180)}), (2, 'a', ${square(127, 26, 0.2)}), ` +
          `(3, 'b', ${square(127.3, 26, 0.2)}), (4, 'c', ${square(127.6, 26, 0.2)}), (5, 'd', ${square(127.9, 26, 0.2)}), ` +
          `(6, 'okinawa', ${big})`
      )
      try {
        await page.goto(tableUrl(t, table))
        await page.getByText('全 6 行').waitFor()
        await page.getByText('図形で表示（GIS）').click()
        // The world rectangle is left out of the frame (offered as a checkbox), and the large value is not "unreadable".
        await expect(page.getByText('4 件の図形', { exact: true })).toBeVisible()
        await expect(page.getByLabel(/範囲が広すぎる図形 1 件も含めて表示/)).not.toBeChecked()
        await expect(
          page.getByText('1 件は大きすぎて、このページには途中までしか届いていません（64 KB 超）')
        ).toBeVisible()
        // Loading it whole draws it.
        await page.getByRole('button', { name: '全体を読み込む（1 件）' }).click()
        await expect(page.getByText('5 件の図形', { exact: true })).toBeVisible()
        await expect(page.getByRole('img', { name: 'shape の図形 5 件' }).locator('title')).toContainText(['okinawa'])
        await page.getByLabel(/範囲が広すぎる図形 1 件も含めて表示/).check()
        await expect(page.getByText('6 件の図形', { exact: true })).toBeVisible()
        // Zoom and back.
        const picture = page.getByRole('img', { name: 'shape の図形 6 件' })
        const before = await picture.locator('path').first().getAttribute('d')
        await page.getByRole('button', { name: '拡大' }).click()
        expect(await picture.locator('path').first().getAttribute('d')).not.toBe(before)
        await page.getByRole('button', { name: '全体を表示' }).click()
        expect(await picture.locator('path').first().getAttribute('d')).toBe(before)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
