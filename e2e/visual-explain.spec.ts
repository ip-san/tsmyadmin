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
