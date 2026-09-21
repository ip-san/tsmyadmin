import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

async function sql(page: Page, t: Target, statement: string, database = t.database, schema?: string) {
  const res = await page.request.post(`/api/databases/${database}/sql`, {
    data: { sql: statement, stopOnError: true, ...(schema ? { schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`designer long names (${t.dialect})`, () => {
    test('keeps a long table or column name inside its box', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const scratch = `e2e_long_${Date.now().toString(36)}`
      // A database of its own on MySQL, a schema of the shared database on PostgreSQL: the fixtures stay as they are.
      const mysql = t.dialect === 'mysql'
      const db = mysql ? scratch : t.database
      const schema = mysql ? undefined : scratch
      if (mysql) await sql(page, t, `CREATE DATABASE ${scratch}`)
      else await sql(page, t, `CREATE SCHEMA ${scratch}`)
      const parent = 'customer_billing_address_verification_status_history'
      const child = 'order_line_item_shipment_tracking_event_records'
      const column = 'customer_billing_address_verification_status_history_id'
      try {
        await sql(
          page,
          t,
          `CREATE TABLE ${parent} (id INT PRIMARY KEY);
           CREATE TABLE ${child} (id INT PRIMARY KEY, ${column} INT, CONSTRAINT fk_long FOREIGN KEY (${column}) REFERENCES ${parent} (id))`,
          db,
          schema
        )
        await page.goto(`/db/${db}/designer${schema ? `?schema=${schema}` : ''}`)
        await expect(page.getByRole('button', { name: new RegExp(`^テーブル ${child}`) })).toBeVisible()
        // Every text of every box ends before the box does (the box is the rect that opens its group).
        const overflowing = await page.evaluate(() => {
          const out: string[] = []
          for (const group of document.querySelectorAll<SVGGElement>('figure svg g[role="button"]')) {
            const rect = group.querySelector('rect')
            if (!rect) continue
            const width = rect.getBBox().width
            for (const text of group.querySelectorAll('text')) {
              const box = text.getBBox()
              if (box.x + box.width > width + 0.5)
                out.push(`${text.textContent} ends at ${box.x + box.width} of ${width}`)
            }
          }
          return out
        })
        expect(overflowing).toEqual([])
        // What was cut is still named in full: on hover (the title) and to a screen reader (the box's label).
        await expect(page.locator('figure svg title', { hasText: child })).toHaveCount(1)
        const box = page.getByRole('button', { name: new RegExp(`^テーブル ${child}`) })
        await expect(box).toBeVisible()

        // Until a table is picked the page says why names end in “…”; picking one reads its names whole below the
        // diagram, where they can be selected and copied (a tooltip does not reach a touch screen or the keyboard).
        await expect(page.getByText('枠に収まらない名前は「…」で切っています')).toBeVisible()
        await box.click()
        const whole = page.getByRole('status').filter({ hasText: '選択中のテーブル' })
        await expect(whole).toContainText(child)
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])
        await expect(whole.getByRole('listitem').filter({ hasText: column })).toHaveCount(1)
        // From the keyboard: focusing the other box shows its names instead.
        await page.getByRole('button', { name: new RegExp(`^テーブル ${parent}`) }).focus()
        await expect(whole).toContainText(parent)
        await expect(whole).not.toContainText(child)
      } finally {
        if (mysql) await sql(page, t, `DROP DATABASE IF EXISTS ${scratch}`)
        else await sql(page, t, `DROP SCHEMA IF EXISTS ${scratch} CASCADE`)
      }
    })
  })
}
