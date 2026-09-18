import { expect } from '@playwright/test'
import { PASSKEY_BASE_URL, test } from './helpers.ts'
import { createAccount, dropAccount, signIn } from './two-factor.ts'

// Passkeys are bound to a host name, and live with the account in the persistent store.
test.use({ baseURL: PASSKEY_BASE_URL })

test.describe('passkeys', () => {
  test.setTimeout(90_000)

  test('enrols a passkey as the first factor, signs in with it, and removes it with it', async ({
    page,
    browserName,
  }) => {
    // Chrome's virtual authenticator (DevTools protocol) stands in for a security key; WebKit has none to drive.
    test.skip(browserName !== 'chromium', 'needs the Chromium virtual authenticator')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    })
    const name = `e2e_pk_${Date.now().toString(36)}`
    const password = 'pw-passkey-1'
    await createAccount(page, name, password)
    try {
      await signIn(page, name, password)
      await page.goto('/security')
      await page.getByRole('button', { name: 'パスキーで登録する' }).click()
      // The first factor comes with recovery codes, shown before anything else.
      await expect(page.getByRole('heading', { name: '回復用コード' })).toBeVisible()
      await page.getByRole('button', { name: '回復用コードを保管しました' }).click()
      await expect(page.getByText(/パスキー 1（/)).toBeVisible()
      await page.getByRole('button', { name: '切断' }).click()

      // The next login asks for the factor, and the passkey answers it.
      await signIn(page, name, password)
      await page.getByRole('button', { name: 'パスキーで確認' }).click()
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()

      // With the code field left empty, the passkey is the proof for removing it — which turns the factor off.
      await page.goto('/security')
      await page.getByRole('button', { name: /パスキー 1（.*）: 削除/ }).click()
      await expect(page.getByRole('button', { name: 'パスキーで登録する' })).toBeVisible()
      await page.getByRole('button', { name: '切断' }).click()
      await signIn(page, name, password)
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
    } finally {
      await dropAccount(page, name)
    }
  })
})
