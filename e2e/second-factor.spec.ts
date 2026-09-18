import { createHmac } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, PERSISTENT_BASE_URL, TARGETS, test } from './helpers.ts'

// The second factor is kept with the account, which only the persistent store can do.
test.use({ baseURL: PERSISTENT_BASE_URL })

const t = TARGETS[0] as (typeof TARGETS)[number]

/**
 * TOTP, written again here rather than imported: a test that computes the code with the implementation under
 * test would agree with it however wrong both are.
 */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of secret.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

/** Signs in as a throwaway account, so the fixture account is never left enrolled for the other specs. */
async function signIn(page: Page, user: string, password: string, code?: string) {
  await page.goto('/login')
  await page.getByRole('button', { name: '接続' }).waitFor()
  const presetSelect = page.getByLabel('接続先')
  await presetSelect.selectOption('')
  await page.getByLabel('サーバー種別').selectOption(t.dialect)
  await page.getByLabel('ホスト').fill(t.host)
  await page.getByLabel('ポート').fill(String(t.port))
  await page.getByLabel('ユーザー名').fill(user)
  await page.getByLabel('パスワード').fill(password)
  // No database: the throwaway account has no rights to the fixture one, and the second factor is server-level.
  await page.getByLabel('データベース').fill('')
  if (code !== undefined) await page.getByLabel('ワンタイムコード').fill(code)
  await page.getByRole('button', { name: '接続' }).click()
  // Wait for the answer before going anywhere: navigating while the login is still in flight lands on the
  // route guard's redirect instead of the page the test asked for.
  await expect(
    page
      .getByRole('heading', { name: 'サーバー', exact: true })
      .or(page.getByLabel('ワンタイムコード'))
      .or(page.getByRole('alert'))
      .first()
  ).toBeVisible()
}

test.describe('second factor', () => {
  // An account of its own, several logins, and a wait for the next 30-second step: far past the default budget.
  test.setTimeout(180_000)

  test('enrols, is asked for at the next login, refuses a used code, and can be removed', async ({ page }) => {
    const name = `e2e_2fa_${Date.now().toString(36)}`
    const password = 'pw-2fa-123'
    await login(page, t)
    // A user of its own: the fixture account is shared with every other spec.
    await page.goto('/users')
    await page.getByRole('button', { name: 'ユーザーを作成' }).click()
    await page.getByLabel('ユーザー名').fill(name)
    await page.getByLabel('パスワード', { exact: true }).fill(password)
    await page.getByLabel('パスワード（確認）').fill(password)
    await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
    await confirmPreview(page, /CREATE (USER|ROLE)/)
    await page.getByRole('button', { name: '切断' }).click()

    try {
      await signIn(page, name, password)
      await page.goto('/security')
      await page.getByRole('button', { name: '2 要素認証を登録する' }).click()
      const secret = (await page.getByLabel('登録する鍵').textContent()) ?? ''
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      const recovery = ((await page.locator('pre').textContent()) ?? '').split('\n').filter(Boolean)
      expect(recovery).toHaveLength(10)
      const enrolCode = totp(secret)
      await page.getByLabel('コード').fill(enrolCode)
      await page.getByRole('button', { name: '登録を完了する' }).click()
      await expect(page.getByText(/登録済みです/)).toBeVisible()

      // Signing in again now needs a code: the field appears only once the server asks for it.
      await page.getByRole('button', { name: '切断' }).click()
      await signIn(page, name, password)
      await expect(page.getByLabel('ワンタイムコード')).toBeVisible()
      await page.getByLabel('ワンタイムコード').fill('000000')
      await page.getByRole('button', { name: '接続' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      // The code that completed the enrolment is spent: it does not work a second time inside its 30 seconds.
      await page.getByLabel('ワンタイムコード').fill(enrolCode)
      await page.getByRole('button', { name: '接続' }).click()
      await expect(page.getByRole('alert')).toBeVisible()

      // A recovery code works once, and is then gone.
      await page.getByLabel('ワンタイムコード').fill(recovery[0] ?? '')
      await page.getByRole('button', { name: '接続' }).click()
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
      await page.goto('/security')
      await expect(page.getByText(/回復用コード: 9 個/)).toBeVisible()

      // Removing it takes a code from the app, which means waiting for one the enrolment did not already spend.
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000)
      await page.getByLabel('コード').fill(totp(secret))
      await page.getByRole('button', { name: '2 要素認証を解除する' }).click()
      await expect(page.getByRole('button', { name: '2 要素認証を登録する' })).toBeVisible()

      // And the password alone is enough again.
      await page.getByRole('button', { name: '切断' }).click()
      await signIn(page, name, password)
      await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
    } finally {
      await page
        .getByRole('button', { name: '切断' })
        .click()
        .catch(() => undefined)
      await login(page, t)
      await page.goto('/users')
      await page.getByRole('button', { name: `${t.dialect === 'mysql' ? `${name}@%` : name}: 削除` }).click()
      await confirmPreview(page, /DROP (USER|ROLE)/, name)
    }
  })
})
