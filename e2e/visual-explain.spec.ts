import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'
import { openPlan } from './plan.ts'

for (const t of TARGETS) {
  test.describe(`visual explain (${t.dialect})`, () => {
    test('draws the tables a statement reads, in the order it reads them, without running it', async ({ page }) => {
      const plan = await openPlan(page, t)
      // Which access each server picks is its own (and changes with the data); that both tables are read is not.
      const steps = plan.getByRole('region', { name: '段ごとの説明' }).getByRole('listitem')
      await expect(steps).toHaveCount(2)
      await expect(steps.filter({ hasText: /^1\. users / })).toHaveCount(1)
      await expect(steps.filter({ hasText: /^2\. posts / })).toHaveCount(1)
      await expect(steps.nth(1).getByRole('button')).toHaveAttribute('aria-current', 'step')
      await expect(plan.locator('[aria-current="step"]').first()).toContainText('posts')
      await plan.getByText('サーバーが返した計画（JSON）').click()
      await expect(plan.locator('pre')).toBeVisible()
      await plan.getByRole('button', { name: '閉じる' }).click()
      await expect(plan).toBeHidden()
      // Nothing ran: no result was added under the editor.
      await expect(page.getByRole('region', { name: '文 1' })).toHaveCount(0)
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
