import { expect } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, TARGETS, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

// The compose servers log no slow statements (MySQL's slow log is off, PostgreSQL has no pg_stat_statements): the
// report is answered here, with statements of this test's own table, and the rest (the SQL tab, its plan) is real.
for (const t of TARGETS) {
  test.describe(`a logged statement's plan (${t.dialect})`, () => {
    test("opens a logged statement's plan in the database it ran in, and asks for the values it was logged without", async ({
      page,
    }) => {
      await login(page, t)
      const table = scratchName('e2e_logged')
      const target = t.schema ? `"${t.schema}".${table}` : table
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
      try {
        const kind = t.dialect === 'mysql' ? 'slowLog' : 'statements'
        await page.route(`**/api/server/diagnostics/${kind}*`, (route) =>
          route.fulfill({
            json: {
              status: 'ok',
              columns: ['statement', 'database', 'runs', 'totalSeconds', 'maxSeconds', 'rows'],
              rows: [
                [`SELECT * FROM ${target} WHERE v = 1`, t.database, '3', '1.5', '0.9', '0'],
                [`SELECT * FROM ${target} WHERE v = $1`, t.database, '9', '0.5', '0.1', '0'],
                ['COMMIT', t.database, '30', '0.1', '0.01', '0'],
              ],
              text: null,
            },
          })
        )
        await page.goto('/monitor')
        const logs = t.dialect === 'mysql' ? 'スロークエリログ' : '負荷の高い文（pg_stat_statements）'
        const report = page.getByRole('table', { name: logs })
        await expect(report.getByRole('button', { name: '1 行目の文の実行計画を見る' })).toBeVisible()
        // Nothing EXPLAIN takes: no plan.
        await expect(report.getByRole('button', { name: '3 行目の文の実行計画を見る' })).toHaveCount(0)
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])

        // Logged with its values: in the SQL tab of its database, drawn at once.
        await report.getByRole('button', { name: '1 行目の文の実行計画を見る' }).click()
        await expect(page).toHaveURL(new RegExp(`/db/${t.database}/sql`))
        await expect(page.getByRole('textbox', { name: 'SQL エディタ' })).toContainText(`WHERE v = 1`)
        const plan = page.getByRole('region', { name: '実行計画', exact: true })
        await expect(plan.getByText(table).first()).toBeVisible()

        // Logged without them: given first, under the run options, then drawn.
        await page.goto('/monitor')
        await report.getByRole('button', { name: '2 行目の文の実行計画を見る' }).click()
        const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
        await expect(editor).toContainText('WHERE v = :p1')
        await expect(editor).toContainText('実行のオプション')
        await expect(page.getByRole('region', { name: '実行計画', exact: true })).toHaveCount(0)
        await page.getByText('実行のオプション (1 個のパラメーター)').click()
        await page.getByLabel('p1 の値').fill('2')
        await page.getByRole('button', { name: '図で見る', exact: true }).click()
        await expect(plan.getByText(table).first()).toBeVisible()
      } finally {
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
