import { expect } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, TARGETS, tableUrl, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

// Only PostgreSQL keeps what a failed concurrent build made (MySQL leaves nothing).
for (const t of TARGETS.filter((x) => x.dialect === 'postgres')) {
  test.describe(`an index a failed build left unusable (${t.dialect})`, () => {
    test('is named apart in the structure, and dropped through the preview without stopping writes', async ({
      page,
    }) => {
      await login(page, t)
      const table = scratchName('e2e_left')
      const index = `${table}_idx`
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, a INT)`)
      try {
        await sqlOn(page, t, `INSERT INTO ${table} (id, a) VALUES (1, 7), (2, 7)`)
        // Fails on the duplicates, and leaves the index behind, unusable.
        const res = await page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql: `CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${table} (a)`, schema: t.schema },
        })
        expect(((await res.json()) as { kind: string }[]).some((r) => r.kind === 'error')).toBe(true)

        await page.goto(tableUrl(t, table, '/structure'))
        const left = page.getByRole('region', { name: '使えないインデックス' })
        await expect(left).toContainText(index)
        await expect(page.getByRole('table', { name: 'インデックス' }).getByText(index)).toHaveCount(0)
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])

        await left.getByRole('button', { name: `インデックス ${index}: 削除` }).click()
        const dialog = page.getByRole('dialog', { name: 'インデックスを削除' })
        await expect(dialog).toContainText('DROP INDEX CONCURRENTLY')
        await dialog.getByRole('button', { name: '実行' }).click()
        await expect(page.getByRole('region', { name: '使えないインデックス' })).toHaveCount(0)
      } finally {
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
