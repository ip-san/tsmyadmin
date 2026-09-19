import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`insert form (${t.dialect})`, () => {
    test('inserts several rows, through functions, a file and a suggested foreign key', async ({ page }) => {
      await login(page, t)
      const table = `e2e_ins_${Date.now().toString(36)}`
      const blob = t.dialect === 'mysql' ? 'BLOB' : 'BYTEA'
      await sql(
        page,
        t,
        // A table-level FOREIGN KEY: MySQL ignores a REFERENCES written on the column.
        `CREATE TABLE ${table} (id INT PRIMARY KEY, code VARCHAR(40), uid INT, pic ${blob}, FOREIGN KEY (uid) REFERENCES users(id))`
      )
      try {
        await page.goto(tableUrl(t, table, '/insert'))
        await page.getByLabel('一度に入れる行数').selectOption('3')
        // Row 1: a hashed value, a suggested foreign key value, a file.
        await page.getByLabel('id（1 行目）', { exact: true }).fill('1')
        await page.getByLabel('code（1 行目）', { exact: true }).fill('abc')
        await page.getByLabel('code（1 行目）: 関数').selectOption('md5')
        const uid = page.getByLabel('uid（1 行目）', { exact: true })
        // The referenced column's values are offered as suggestions.
        await expect(page.locator(`datalist#${await uid.getAttribute('list')} option`)).not.toHaveCount(0)
        await uid.fill('1')
        await page.getByLabel('pic（1 行目）: ファイルから').setInputFiles({
          name: 'x.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from([1, 2, 3]),
        })
        // Row 2: a function; row 3 is left alone and not inserted.
        await page.getByLabel('id（2 行目）', { exact: true }).fill('2')
        await page.getByLabel('code（2 行目）', { exact: true }).fill('mixed Case')
        await page.getByLabel('code（2 行目）: 関数').selectOption('upper')
        await page.getByRole('button', { name: '挿入する' }).click()
        await expect(page.getByText(/2 行を挿入しました/)).toBeVisible()

        const read = await sql(page, t, `SELECT id, code, uid FROM ${table} ORDER BY id`)
        expect(read[0].result.rows).toEqual([
          [1, '900150983cd24fb0d6963f7d28e17f72', 1],
          [2, 'MIXED CASE', null],
        ])
        const bytes = await sql(
          page,
          t,
          t.dialect === 'mysql'
            ? `SELECT HEX(pic) FROM ${table} WHERE id = 1`
            : `SELECT encode(pic, 'hex') FROM ${table} WHERE id = 1`
        )
        expect(String(bytes[0].result.rows[0][0]).toLowerCase()).toBe('010203')
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
