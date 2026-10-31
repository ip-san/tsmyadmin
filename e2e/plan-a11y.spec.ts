import { expect } from '@playwright/test'
import { TARGETS, test } from './helpers.ts'
import { openPlan, trialPlan } from './plan.ts'
import { pageProblems } from './scan.ts'

async function scan(page: Parameters<typeof openPlan>[0]) {
  const problems = await pageProblems(page)
  expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
  expect(problems.layout, 'layout').toEqual([])
}

// The SQL tab's plan in its states: drawn, presented, measured, and an index tried.
for (const t of TARGETS) {
  test.describe(`accessibility of a statement plan (axe-core, ${t.dialect})`, () => {
    test('statement plan presented', async ({ page }) => {
      const plan = await openPlan(page, t)
      await plan.getByRole('button', { name: 'プレゼンで見る' }).click()
      const tour = page.getByRole('dialog', { name: '実行計画のプレゼン' })
      await tour.getByRole('button', { name: /^3\. / }).click()
      await expect(tour.getByRole('heading', { level: 3 })).toHaveText(/ を読む$/)
      await scan(page)
    })

    test('SQL tab with a statement plan drawn, asked to be measured, then measured', async ({ page }) => {
      const plan = await openPlan(page, t)
      await scan(page)
      await plan.getByRole('button', { name: '実際に実行して測る' }).click()
      const run = plan.getByRole('button', { name: '実行して測る', exact: true })
      await run.waitFor()
      await scan(page)
      await run.click()
      await expect(plan.getByText(/^実際に実行して測った値です/)).toBeVisible()
      await scan(page)
    })

    test('an index tried: asked, made and compared', async ({ page }) => {
      const { trial, table, drop } = await trialPlan(page, t)
      try {
        await scan(page)
        await trial.getByRole('button', { name: `${table}（level）に作って試す` }).click()
        const make = page.getByRole('dialog', { name: 'インデックスを追加' })
        await expect(make.getByRole('button', { name: '実行する' })).toBeEnabled()
        await scan(page)
        await make.getByRole('button', { name: '実行する' }).click()
        await expect(trial.getByText(/^実行の時間: /)).toBeVisible()
        await scan(page)
      } finally {
        await drop()
      }
    })
  })
}
