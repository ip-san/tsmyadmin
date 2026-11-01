import { expect } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, TARGETS, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

// Indexes the planner assumes are PostgreSQL's (HypoPG, installed on the test server); MySQL's estimate offers none.
for (const t of TARGETS) {
  test.describe(`an index tried without building it (${t.dialect})`, () => {
    test('plans as if the suggested index were there, on the estimate, and goes back', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await login(page, t)
      const table = scratchName('e2e_hypo')
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, level INT NOT NULL)`)
      try {
        const values = Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${i % 50})`).join(', ')
        await sqlOn(page, t, `INSERT INTO ${table} (id, level) VALUES ${values}`)
        if (t.dialect === 'postgres') await sqlOn(page, t, 'CREATE EXTENSION IF NOT EXISTS hypopg')
        await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
        await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
        await page.keyboard.type(`SELECT id FROM ${table} WHERE level = 3`)
        await page.getByRole('button', { name: '図で見る', exact: true }).click()
        const plan = page.getByRole('region', { name: '実行計画', exact: true })
        await plan.getByRole('img', { name: '実行計画で読むテーブルの図' }).waitFor()
        const assume = plan.getByRole('region', { name: 'インデックスを作らずに試す（見込み）' })
        if (t.dialect === 'mysql') {
          await expect(assume).toHaveCount(0)
          return
        }
        await assume.getByRole('button', { name: `${table}（level）があるものとして見る` }).click()
        const index = `idx_${table}_level`
        await expect(assume.getByRole('status')).toHaveText(`${index} があるものとしての計画です（見込み）`)
        // Whether the server would read through it on so few rows is its own; that the estimates are set side by side
        // is not.
        await expect(assume.getByText(/^見込みのコスト: /)).toBeVisible()
        await expect(assume.getByRole('listitem').filter({ hasText: new RegExp(`^${table}: 全件 `) })).toHaveCount(1)
        // Nothing was built: the table has its primary key only, and the measuring is still to be asked for.
        await expect(plan.getByRole('button', { name: '実際に実行して測る' })).toBeVisible()
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])
        await assume.getByRole('button', { name: '元の計画に戻す' }).click()
        await expect(assume.getByRole('status')).toHaveText('')
      } finally {
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
