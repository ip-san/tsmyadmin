import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`table operations (${t.dialect})`, () => {
    test('converts every column to a collation, reorders the rows, and copies elsewhere with its keys', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const table = `e2e_ops_${Date.now().toString(36)}`
      const other = t.dialect === 'mysql' ? 'tsmyadmin_other' : 'app'
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20), user_id INT)`)
      await sql(page, t, `ALTER TABLE ${table} ADD CONSTRAINT ${table}_fk FOREIGN KEY (user_id) REFERENCES users (id)`)
      await sql(page, t, `INSERT INTO ${table} VALUES (2, 'b', 1), (1, 'a', 2)`)
      try {
        await page.goto(tableUrl(t, table, '/operations'))
        const convert = page.getByRole('form', { name: '全カラムの照合順序を変更' })
        await convert.getByLabel('照合順序').fill(t.dialect === 'mysql' ? 'utf8mb4_bin' : 'C')
        await convert.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(
          page,
          t.dialect === 'mysql' ? /CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/ : /COLLATE "C"/
        )

        const order = page.getByRole('form', { name: '行の並び順を変更' })
        if (t.dialect === 'mysql') await order.getByLabel('並べ替えるカラム').selectOption('name')
        await order.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /ORDER BY `name`/ : /CLUSTER/)

        if (t.dialect === 'mysql') {
          await page.getByLabel('行フォーマット').selectOption('DYNAMIC')
          await page
            .getByRole('form', { name: 'テーブルオプション' })
            .getByRole('button', { name: '次へ（SQL を確認）' })
            .click()
          await confirmPreview(page, /ROW_FORMAT = DYNAMIC/)
          // The statistics options of InnoDB: on, off, or the server's own default.
          await page.getByLabel('STATS_PERSISTENT（InnoDB）').selectOption('0')
          await page.getByLabel('STATS_AUTO_RECALC（InnoDB）').selectOption('DEFAULT')
          await page
            .getByRole('form', { name: 'テーブルオプション' })
            .getByRole('button', { name: '次へ（SQL を確認）' })
            .click()
          await confirmPreview(page, /STATS_PERSISTENT = 0, STATS_AUTO_RECALC = DEFAULT/)
        }

        // Into another database / schema, replacing whatever has that name (confirmed by it), keys included.
        await sql(page, t, `CREATE TABLE ${other}.${table} (x INT)`)
        const copy = page.getByRole('form', { name: 'テーブルをコピー' })
        await copy
          .getByLabel(t.dialect === 'mysql' ? 'コピー先のデータベース' : 'コピー先のスキーマ')
          .selectOption(other)
        await copy.getByLabel('コピー先のテーブル名').fill(table)
        await copy.getByLabel('同じ名前のテーブルがあれば削除してから作る').check()
        await copy.getByLabel('外部キーもコピーする（1 件）').check()
        await copy.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /DROP TABLE IF EXISTS[\s\S]*FOREIGN KEY/, table)
        await expect(page).toHaveURL(
          new RegExp(t.dialect === 'mysql' ? `/db/${other}/table/${table}` : `schema=${other}`)
        )
        const rows = await sql(page, t, `SELECT COUNT(*) FROM ${other}.${table}`)
        expect(Number(rows[0].result.rows[0][0])).toBe(2)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${other}.${table}`)
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
