import { expect } from '@playwright/test'
import { login, PERSISTENT_BASE_URL, test } from './helpers.ts'
import { createAccount, dropAccount, enrol, signIn, t, totp } from './two-factor.ts'

// The second factor is kept with the account, which only the persistent store can do.
test.use({ baseURL: PERSISTENT_BASE_URL })

test.describe('second factor', () => {
  // An account of its own, several logins, and a wait for the next 30-second step: far past the default budget.
  test.setTimeout(180_000)

  test('enrols, is asked for at the next login, refuses a used code, and can be removed', async ({ page }) => {
    const name = `e2e_2fa_${Date.now().toString(36)}`
    const password = 'pw-2fa-123'
    await createAccount(page, name, password)

    try {
      await signIn(page, name, password)
      await page.goto('/security')
      await page.getByRole('button', { name: '2 要素認証を登録する' }).click()
      const secret = (await page.locator('#second-factor-secret').textContent()) ?? ''
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      await expect(page.getByRole('img', { name: '認証アプリで読み取る QR コード' })).toBeVisible()
      const recovery = ((await page.locator('pre').textContent()) ?? '').split('\n').filter(Boolean)
      expect(recovery).toHaveLength(10)
      const enrolCode = totp(secret)
      await page.getByLabel('コード', { exact: true }).fill(enrolCode)
      await page.getByRole('button', { name: '登録を完了する' }).click()
      await expect(page.getByText(/登録済みです/)).toBeVisible()

      // Signing in again now needs a code: the field appears only once the server asks for it.
      await page.getByRole('button', { name: '切断' }).click()
      await signIn(page, name, password)
      await expect(page.getByLabel('ワンタイムコード')).toBeVisible()
      // Each refusal is waited for by the field being emptied: the alert from the one before is still on screen,
      // and typing the next code before the answer arrives would have it wiped by that answer.
      const codeField = page.getByLabel('ワンタイムコード')
      await codeField.fill('000000')
      await page.getByRole('button', { name: '接続' }).click()
      await expect(codeField).toHaveValue('')
      await expect(page.getByRole('alert')).toContainText('コードが正しくありません')
      // The code that completed the enrolment is spent: it does not work a second time inside its 30 seconds.
      await codeField.fill(enrolCode)
      await page.getByRole('button', { name: '接続' }).click()
      await expect(codeField).toHaveValue('')

      // A recovery code works once, and is then gone.
      await page.getByLabel('ワンタイムコード').fill(recovery[0] ?? '')
      await page.getByRole('button', { name: '接続' }).click()
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
      await page.goto('/security')
      await expect(page.getByText(/回復用コード: 9 個/)).toBeVisible()

      // A refused code is not an expired session: the page stays, with the reason on it.
      await page.getByLabel('コード', { exact: true }).fill('000000')
      await page.getByRole('button', { name: '2 要素認証を解除する' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('heading', { name: '2 要素認証' })).toBeVisible()

      // Removing it takes a code from the app, which means waiting for one the enrolment did not already spend.
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000)
      await page.getByLabel('コード', { exact: true }).fill(totp(secret))
      await page.getByRole('button', { name: '2 要素認証を解除する' }).click()
      await expect(page.getByRole('button', { name: '2 要素認証を登録する' })).toBeVisible()

      // And the password alone is enough again.
      await page.getByRole('button', { name: '切断' }).click()
      await signIn(page, name, password)
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
    } finally {
      await dropAccount(page, name)
    }
  })

  test('an operator can reset the second factor of an account that lost its device', async ({ page }) => {
    const name = `e2e_2fr_${Date.now().toString(36)}`
    const password = 'pw-2fr-123'
    await createAccount(page, name, password)
    try {
      await signIn(page, name, password)
      await enrol(page)
      await page.getByRole('button', { name: '切断' }).click()

      // The fixture account can alter any account, so it is offered the reset for this one.
      await login(page, t)
      await page.goto('/users')
      const label = t.dialect === 'mysql' ? `${name}@%` : name
      await page.getByRole('button', { name: `${label}: 2 要素認証を解除…` }).click()
      await page.getByRole('dialog').getByRole('button', { name: '解除する' }).click()
      await expect(page.getByRole('button', { name: `${label}: 2 要素認証を解除…` })).toHaveCount(0)
      await page.getByRole('button', { name: '切断' }).click()

      // The password alone is enough again.
      await signIn(page, name, password)
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
    } finally {
      await dropAccount(page, name)
    }
  })
})
