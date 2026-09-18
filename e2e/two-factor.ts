import { createHmac } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS } from './helpers.ts'

/** The second-factor specs sign in to the first target as throwaway accounts. */
export const t = TARGETS[0] as (typeof TARGETS)[number]

/**
 * TOTP, written again here rather than imported: a test that computes the code with the implementation under
 * test would agree with it however wrong both are.
 */
export function totp(secret: string, at = Date.now()): string {
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
export async function signIn(page: Page, user: string, password: string, code?: string) {
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

/** A throwaway account, created by the fixture one: signing in as it keeps the fixture account unenrolled. */
export async function createAccount(page: Page, name: string, password: string) {
  await login(page, t)
  await page.goto('/users')
  await page.getByRole('button', { name: 'ユーザーを作成' }).click()
  await page.getByLabel('ユーザー名').fill(name)
  await page.getByLabel('パスワード', { exact: true }).fill(password)
  await page.getByLabel('パスワード（確認）').fill(password)
  await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
  await confirmPreview(page, /CREATE (USER|ROLE)/)
  await page.getByRole('button', { name: '切断' }).click()
}

/** Drops the throwaway account as the fixture one, from wherever the test left off (signed in or not). */
export async function dropAccount(page: Page, name: string) {
  // Only when signed in: waiting for a button the login page does not have would spend the test's whole budget.
  const logout = page.getByRole('button', { name: '切断' })
  if (await logout.isVisible()) await logout.click()
  await login(page, t)
  await page.goto('/users')
  await page.getByRole('button', { name: `${t.dialect === 'mysql' ? `${name}@%` : name}: 削除` }).click()
  await confirmPreview(page, /DROP (USER|ROLE)/, name)
}

/** Enrols the signed-in account from the security tab and returns its secret. */
export async function enrol(page: Page): Promise<string> {
  await page.goto('/security')
  await page.getByRole('button', { name: '認証アプリで登録する' }).click()
  const secret = (await page.locator('#second-factor-secret').textContent()) ?? ''
  await page.getByLabel('コード', { exact: true }).fill(totp(secret))
  await page.getByRole('button', { name: '登録を完了する' }).click()
  await expect(page.getByText(/登録済みです/)).toBeVisible()
  return secret
}
