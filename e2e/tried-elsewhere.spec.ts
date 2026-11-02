import { type BrowserContext, expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'
import { trialPlan } from './plan.ts'
import { pageProblems } from './scan.ts'

// An index tried from a plan is marked on the server: another browser, which remembers nothing of it, tells it apart
// in the table's Structure and offers to drop it from the plan.
for (const t of TARGETS) {
  test.describe(`an index tried in another browser (${t.dialect})`, () => {
    test('is told apart in the Structure and dropped from the plan of another browser', async ({ page, browser }) => {
      const { trial, table, index, drop } = await trialPlan(page, t)
      const contexts: BrowserContext[] = []
      try {
        await trial.getByRole('button', { name: `${table}（level）に作って試す` }).click()
        const make = page.getByRole('dialog', { name: 'インデックスを追加' })
        await make.getByRole('button', { name: '実行する' }).click()
        await expect(trial.getByRole('status').filter({ hasText: `${index} を作って測り直しました` })).toBeVisible()

        const context = await browser.newContext()
        contexts.push(context)
        const other = await context.newPage()
        await login(other, t)
        await other.goto(tableUrl(t, table, '/structure'))
        const indexes = other.getByRole('table', { name: 'インデックス' })
        await expect(indexes.getByRole('row').filter({ hasText: index })).toContainText('実行計画で試した')
        const problems = await pageProblems(other)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])

        // The same statement's plan in the other browser: the index is left from before, and dropped from there.
        await other.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
        await other.getByRole('textbox', { name: 'SQL エディタ' }).click()
        await other.keyboard.type(`SELECT id FROM ${table} WHERE level = 3`)
        await other.getByRole('button', { name: '図で見る', exact: true }).click()
        const plan = other.getByRole('region', { name: '実行計画', exact: true })
        await plan.getByRole('button', { name: '実際に実行して測る' }).click()
        await plan.getByRole('button', { name: '実行して測る', exact: true }).click()
        const there = plan.getByRole('region', { name: 'インデックスを試す' })
        await expect(
          there.getByText(`${table} の ${index} は、前に実行計画で試したインデックスです`, { exact: false })
        ).toBeVisible()
        await there.getByRole('button', { name: `${index} を消す` }).click()
        const remove = other.getByRole('dialog', { name: 'インデックスを削除' })
        await expect(remove).toContainText(index)
        await remove.getByRole('button', { name: '実行する' }).click()
        await expect(there.getByRole('button', { name: `${index} を消す` })).toHaveCount(0)
        await other.goto(tableUrl(t, table, '/structure'))
        await expect(
          other.getByRole('table', { name: 'インデックス' }).getByRole('row').filter({ hasText: index })
        ).toHaveCount(0)
      } finally {
        for (const c of contexts) await c.close().catch(() => undefined)
        await drop()
      }
    })
  })
}
