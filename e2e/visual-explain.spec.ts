import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'
import { openPlan } from './plan.ts'

for (const t of TARGETS) {
  test.describe(`visual explain (${t.dialect})`, () => {
    test('draws the tables a statement reads, step by step, without running it', async ({ page }) => {
      const plan = await openPlan(page, t)
      // Which access each server picks is its own (and changes with the data); that both tables are read is not.
      const steps = plan.getByRole('region', { name: '段ごとの説明' }).getByRole('listitem')
      await expect(steps).toHaveCount(2)
      // The join order is the server's too (it differs between versions and with the rows other tests leave).
      await expect(steps.filter({ hasText: /^\d\. users / })).toHaveCount(1)
      await expect(steps.filter({ hasText: /^\d\. posts / })).toHaveCount(1)
      await expect(steps.nth(1).getByRole('button')).toHaveAttribute('aria-current', 'step')
      // The tree marks the node read at the current (last) step: the same table the last sentence names.
      const last = (await steps.nth(1).textContent())?.match(/^\d\. (\w+) /)?.[1] ?? ''
      await expect(plan.getByRole('figure', { name: '実行計画の木' }).locator('[aria-current="step"]')).toContainText(
        last
      )
      await plan.getByText('サーバーが返した計画（JSON）').click()
      await expect(plan.locator('pre')).toBeVisible()
      await plan.getByRole('button', { name: '閉じる' }).click()
      await expect(plan).toBeHidden()
      // Nothing ran: no result was added under the editor.
      await expect(page.getByRole('region', { name: '文 1' })).toHaveCount(0)
    })

    test('presents the plan scene by scene, in the order the server reads the tables', async ({ page }) => {
      const plan = await openPlan(page, t)
      await plan.getByRole('button', { name: 'プレゼンで見る' }).click()
      const tour = page.getByRole('dialog', { name: '実行計画のプレゼン' })
      await expect(tour.getByRole('heading', { level: 3 })).toHaveText('この文の実行計画')
      // One scene per table read, in the server's order (which differs between servers): both tables are told.
      await expect(tour.getByRole('button', { name: /^\d+\. users を読む$/ })).toHaveCount(1)
      await expect(tour.getByRole('button', { name: /^\d+\. posts を読む$/ })).toHaveCount(1)
      await tour.getByRole('button', { name: /^3\. / }).click()
      await expect(tour.getByRole('heading', { level: 3 })).toHaveText(/^(users|posts) を読む$/)
      await tour.getByRole('button', { name: /^\d+\. まとめ$/ }).click()
      await expect(tour.getByText(/^テーブルを読む段は 2 つです。/)).toBeVisible()
      await tour.getByRole('button', { name: '閉じる' }).click()
      await expect(tour).toBeHidden()
      await expect(plan.getByRole('button', { name: 'プレゼンで見る' })).toBeFocused()
    })

    test('runs the statement to measure it once asked, and presents the run beside the estimates', async ({ page }) => {
      const plan = await openPlan(page, t)
      const measure = plan.getByRole('button', { name: '実際に実行して測る' })
      await measure.click()
      const ask = plan.getByRole('group', { name: '実行して測る前の確認' })
      await expect(ask).toContainText('30 秒で止めます')
      await ask.getByRole('button', { name: '実行して測る' }).click()
      await expect(
        plan.getByRole('status').filter({ hasText: /^実際に実行して測った計画を出しています/ })
      ).toBeVisible()
      await expect(ask).toBeHidden()
      await expect(measure).toBeFocused()
      // How many rows each step gave is the server's (and the other tests'); that every read was measured is not.
      const tree = plan.getByRole('figure', { name: '実行計画の木' })
      await expect(tree.getByText(/実際 [\d,]+ 行/).first()).toBeVisible()
      await expect(plan.getByText(/^実際に実行して測った値です/)).toBeVisible()
      await plan.getByRole('button', { name: 'プレゼンで見る' }).click()
      const tour = page.getByRole('dialog', { name: '実行計画のプレゼン' })
      await expect(tour.getByText(/^この文を実際に実行して測った計画です/)).toBeVisible()
      await tour.getByRole('button', { name: /^\d+\. 見込みと実際$/ }).click()
      await expect(tour.getByRole('heading', { level: 3 })).toHaveText('見込みと実際')
      // Nothing was left under the editor: measuring is not a run of the SQL tab.
      await tour.getByRole('button', { name: '閉じる' }).click()
      await expect(page.getByRole('region', { name: '文 1' })).toHaveCount(0)
    })

    test('fills in the parameters before drawing, as a run does', async ({ page }) => {
      await login(page, t)
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
      await page.keyboard.type('SELECT name FROM users WHERE age > :minAge')
      await page.getByText(/1 個のパラメーター/).click()
      await page.getByLabel('minAge の値').fill('20')
      await page.getByRole('button', { name: '図で見る', exact: true }).click()
      const plan = page.getByRole('region', { name: '実行計画', exact: true })
      await expect(plan.getByRole('img', { name: '実行計画で読むテーブルの図' })).toBeVisible()
      await expect(plan.getByRole('alert')).toHaveCount(0)
    })

    test('says why a script of two statements is not drawn', async ({ page }) => {
      await login(page, t)
      await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
      await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
      await page.keyboard.type('SELECT 1; SELECT 2')
      await expect(page.getByRole('button', { name: '図で見る', exact: true })).toBeDisabled()
    })
  })
}
