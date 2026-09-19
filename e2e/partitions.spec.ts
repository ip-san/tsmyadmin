import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`partitions (${t.dialect})`, () => {
    test('partitions a table, adds, empties and drops partitions', async ({ page }) => {
      await login(page, t)
      const table = `e2e_part_${Date.now().toString(36)}`
      const parts = page.getByRole('table', { name: 'パーティション' })
      try {
        if (t.dialect === 'mysql') {
          await sql(page, t, `CREATE TABLE ${table} (id INT NOT NULL, n INT)`)
          await page.goto(tableUrl(t, table, '/structure'))
          await page.getByRole('button', { name: 'パーティションに分割…' }).click()
          const dialog = page.getByRole('dialog')
          await dialog.getByLabel('分割キー（式またはカラム）').fill('id')
          await dialog.getByLabel('パーティション 1 の範囲').fill('VALUES LESS THAN (10)')
          await dialog.getByRole('button', { name: '行を追加' }).click()
          await dialog.getByLabel('パーティション 2 の範囲').fill('VALUES LESS THAN (20)')
          await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
          await confirmPreview(page, /PARTITION BY RANGE \(id\)/)
        } else {
          // PostgreSQL: a partitioned table is created as one.
          await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
          await page.getByText('テーブルを作成').first().click()
          const form = page.getByRole('form', { name: 'テーブルを作成' })
          await form.getByLabel('テーブル名').fill(table)
          await form.getByLabel('パーティション分割').selectOption('range')
          await form.getByLabel('分割キー（式またはカラム）').fill('id')
          await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
          await confirmPreview(page, /PARTITION BY RANGE \(id\)/)
          await page.getByRole('link', { name: '構造' }).first().waitFor()
          await page.goto(tableUrl(t, table, '/structure'))
          for (const [name, bound] of [
            [`${table}_p0`, 'FOR VALUES FROM (0) TO (10)'],
            [`${table}_p1`, 'FOR VALUES FROM (10) TO (20)'],
          ] as const) {
            await page.getByRole('button', { name: 'パーティションを追加' }).click()
            await page.getByRole('dialog').getByLabel('名前').fill(name)
            await page.getByRole('dialog').getByLabel('範囲 / 値').fill(bound)
            await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
            await confirmPreview(page, /PARTITION OF/)
          }
        }
        const [p0, p1] = t.dialect === 'mysql' ? ['p0', 'p1'] : [`${table}_p0`, `${table}_p1`]
        await expect(parts.getByRole('row')).toHaveCount(3)
        await sql(page, t, `INSERT INTO ${table} (id) VALUES (1), (15)`)

        // Emptying a partition loses its rows: confirmed by its name.
        await page.getByRole('button', { name: `パーティション ${p0}: 空にする` }).click()
        await confirmPreview(page, /TRUNCATE/, p0)
        const rows = await sql(page, t, `SELECT id FROM ${table}`)
        expect(rows[0].result.rows).toEqual([[15]])

        await page.getByLabel(`パーティション ${p1}: 保守`).selectOption('analyze')
        await confirmPreview(page, /ANALYZE/)

        await page.getByRole('button', { name: `パーティション ${p1}: 削除` }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /DROP PARTITION/ : /DROP TABLE/, p1)
        await expect(parts.getByRole('row')).toHaveCount(2)

        if (t.dialect === 'mysql') {
          await page.getByRole('button', { name: 'パーティション分割を解除' }).click()
          await confirmPreview(page, /REMOVE PARTITIONING/)
          await expect(page.getByText('このテーブルはパーティション分割されていません。')).toBeVisible()
        }
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
