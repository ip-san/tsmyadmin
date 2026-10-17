import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'
import { lockChain } from './locks.ts'

for (const t of TARGETS) {
  test.describe(`lock graph (${t.dialect})`, () => {
    test('draws a chain of lock waits and says where it starts', async ({ page, browser }) => {
      test.setTimeout(90_000)
      await login(page, t)
      const chain = await lockChain(page, browser, t)
      try {
        await page.goto('/processes')
        await page.getByLabel('更新間隔').selectOption('2')
        const waits = page.getByRole('table', { name: 'ロック待ち' })
        await expect(waits.getByRole('row').filter({ hasText: chain.marker('c') })).toBeVisible({ timeout: 15_000 })
        // B is in two rows: waiting for A, and holding C up.
        await expect(waits.getByRole('row').filter({ hasText: chain.marker('b') })).toHaveCount(2, { timeout: 15_000 })

        await page.getByRole('button', { name: '図', exact: true }).click()
        await expect(page.getByRole('img', { name: /^ロック待ちの図/ })).toBeVisible()
        // A holds up B, and C through B: two sessions wait for it. Named by its id, so another chain drawn
        // alongside (a test running at the same time) is not taken for this one.
        await expect(
          page.getByRole('listitem').filter({ hasText: `ID ${chain.holder} が元です。2 件のセッション` })
        ).toBeVisible()
        // Each wait in words too: B waits for A.
        await expect(
          page.getByRole('listitem').filter({ hasText: `が ID ${chain.holder} を待っています` })
        ).toBeVisible()

        // Ending A is done from the table, as before.
        await page.getByRole('button', { name: '表', exact: true }).click()
        const holder = waits
          .getByRole('row')
          .filter({ hasText: chain.marker('a') })
          .first()
        await holder.getByRole('button', { name: /: ブロック元を強制終了$/ }).click()
        await page.getByRole('dialog').getByRole('button', { name: '強制終了する' }).click()
        // This chain's waits clear; another test's may still be listed (and the process list below keeps the
        // statements PostgreSQL's sessions ran last, so only the waits table is looked at).
        await expect(waits.getByRole('row').filter({ hasText: chain.marker('b') })).toHaveCount(0, { timeout: 20_000 })
      } finally {
        await chain.end()
      }
    })
  })
}
