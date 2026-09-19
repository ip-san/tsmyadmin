import { expect } from '@playwright/test'
import { PERSISTENT_BASE_URL, test } from './helpers.ts'
import { createAccount, dropAccount, signIn } from './two-factor.ts'

test.describe('preferences kept with the account', () => {
  // Only a persistent session store keeps them; a throwaway account keeps the fixture one's settings untouched.
  test.use({ baseURL: PERSISTENT_BASE_URL })

  test('follow the account into a browser that has never seen them', async ({ page, browser }) => {
    test.setTimeout(90_000)
    const name = `e2e_prefs_${Date.now().toString(36)}`
    await createAccount(page, name, 'pw-prefs')
    try {
      await signIn(page, name, 'pw-prefs')
      await expect(page.locator('html')).not.toHaveClass(/dark/)
      await page.getByRole('button', { name: 'テーマ切替' }).click()
      await page.getByRole('button', { name: 'コンソール', exact: true }).click()
      await expect(page.locator('html')).toHaveClass(/dark/)
      // Shared after a short pause; wait until the server has it.
      await expect
        .poll(async () => (await page.request.get('/api/preferences')).json())
        .toEqual({ theme: 'dark', consoleDocked: true })

      // Another browser: empty storage, the same account.
      const other = await browser.newContext({ baseURL: PERSISTENT_BASE_URL })
      const second = await other.newPage()
      try {
        await signIn(second, name, 'pw-prefs')
        await expect(second.locator('html')).toHaveClass(/dark/)
        await expect(second.getByRole('region', { name: 'SQL コンソール（画面の下に常駐）' })).toBeVisible()
      } finally {
        await other.close()
      }
    } finally {
      await dropAccount(page, name)
    }
  })
})
