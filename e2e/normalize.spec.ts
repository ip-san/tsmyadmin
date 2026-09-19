import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`normalization hints (${t.dialect})`, () => {
    test('points at numbered columns and a reference without a foreign key', async ({ page }) => {
      await login(page, t)
      const table = `e2e_norm_${Date.now().toString(36)}`
      await sql(
        page,
        t,
        `CREATE TABLE ${table} (id INT PRIMARY KEY, user_id INT, phone1 VARCHAR(20), phone2 VARCHAR(20))`
      )
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByText('正規化の手がかり').click()
        const hints = page.getByRole('list', { name: '正規化の手がかり' })
        await expect(hints.getByRole('listitem')).toHaveCount(2)
        await expect(hints).toContainText('phone1, phone2 は同じ種類の値を番号付きで並べています')
        await expect(hints).toContainText('user_id は users を指しているように見えますが')
        await expect(page.getByText(/行が 0 行しかないため/)).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('moves a dependent column and a numbered group into new tables', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const table = `e2e_nsplit_${suffix}`
      const cities = `${table}_city`
      const phones = `e2e_nph_${suffix}`
      const values = Array.from({ length: 24 }, (_, i) => `(${i + 1}, 'c${i % 4}', 'k${(i % 4) % 2}', 'n${i}')`).join(
        ', '
      )
      await sql(
        page,
        t,
        `CREATE TABLE ${table} (id INT PRIMARY KEY, city VARCHAR(20), country VARCHAR(20), name VARCHAR(20))`
      )
      await sql(page, t, `INSERT INTO ${table} VALUES ${values}`)
      await sql(page, t, `CREATE TABLE ${phones} (id INT PRIMARY KEY, phone1 VARCHAR(20), phone2 VARCHAR(20))`)
      await sql(page, t, `INSERT INTO ${phones} VALUES (1, 'a', 'b'), (2, 'c', NULL)`)
      const structure = async (name: string) =>
        (
          await page.request.get(
            `/api/databases/${t.database}/tables/${name}/structure${t.schema ? `?schema=${t.schema}` : ''}`
          )
        ).json()
      try {
        // country follows city: it moves to a table keyed by city, and leaves the original.
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByText('正規化の手がかり').click()
        await page
          .getByRole('button', { name: /country を city をキーにしたテーブルへ: 新しいテーブルに分ける/ })
          .click()
        const form = page.getByRole('form', { name: `${table} を分ける` })
        await expect(form.getByLabel('新しいテーブル名')).toHaveValue(cities)
        await form.getByRole('button', { name: 'SQL を確認' }).click()
        await confirmPreview(page, /ADD PRIMARY KEY[\s\S]*FOREIGN KEY[\s\S]*DROP COLUMN/)
        expect((await structure(table)).columns.map((c: { name: string }) => c.name)).toEqual(['id', 'city', 'name'])
        const made = await structure(cities)
        expect(made.primaryKey).toEqual(['city'])
        expect(made.columns.map((c: { name: string }) => c.name)).toEqual(['city', 'country'])

        // phone1, phone2 become rows of a table pointing back at the original.
        await page.goto(tableUrl(t, phones, '/structure'))
        await page.getByText('正規化の手がかり').click()
        await page
          .getByRole('button', { name: /phone1, phone2 を 1 行ずつのテーブルへ: 新しいテーブルに分ける/ })
          .click()
        const group = page.getByRole('form', { name: `${phones} を分ける` })
        await group.getByLabel('新しいテーブル名').fill(`${phones}_rows`)
        await group.getByRole('button', { name: 'SQL を確認' }).click()
        await confirmPreview(page, /UNION ALL[\s\S]*FOREIGN KEY/)
        const rows = await structure(`${phones}_rows`)
        expect(rows.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'phone'])
        expect(rows.foreignKeys.map((f: { refTable: string }) => f.refTable)).toEqual([phones])
      } finally {
        for (const name of [`${phones}_rows`, phones, table, cities]) await sql(page, t, `DROP TABLE IF EXISTS ${name}`)
      }
    })
  })
}
