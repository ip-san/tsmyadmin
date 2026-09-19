import { expect } from '@playwright/test'
import { login, PERSISTENT_BASE_URL, test } from './helpers.ts'
import { createAccount, dropAccount, signIn, t } from './two-factor.ts'

test.describe('user groups', () => {
  // Kept by the session store, so only a persistent one offers them.
  test.use({ baseURL: PERSISTENT_BASE_URL })

  test('hide the chosen tabs from their members, and only from them', async ({ page }) => {
    test.setTimeout(90_000)
    const member = `e2e_ug_${Date.now().toString(36)}`
    const group = `e2e_group_${Date.now().toString(36)}`
    await createAccount(page, member, 'pw-groups')
    try {
      await login(page, t)
      await page.goto('/user-groups')
      await page.getByLabel('グループ名').fill(group)
      await page.getByRole('checkbox', { name: member }).check()
      await page.getByRole('group', { name: '隠すタブ（サーバー）' }).getByRole('checkbox', { name: 'SQL' }).check()
      await page
        .getByRole('group', { name: '隠すタブ（サーバー）' })
        .getByRole('checkbox', { name: 'プロセス' })
        .check()
      await page.getByRole('button', { name: '保存する' }).click()
      await expect(
        page.getByRole('table', { name: 'ユーザーグループ' }).getByRole('row', { name: new RegExp(group) })
      ).toContainText(member)
      await page.getByRole('button', { name: '切断' }).click()

      await signIn(page, member, 'pw-groups')
      const tabs = page.getByRole('navigation', { name: 'サーバー' })
      await expect(tabs.getByRole('link', { name: 'ステータス' })).toBeVisible()
      await expect(tabs.getByRole('link', { name: 'SQL', exact: true })).toHaveCount(0)
      await expect(tabs.getByRole('link', { name: 'プロセス' })).toHaveCount(0)
      // The console is the SQL tab at the foot of the page: hidden with it.
      await expect(page.getByRole('button', { name: 'コンソール', exact: true })).toHaveCount(0)
      // Not a permission: the member cannot lift it either.
      const lifted = await page.request.post('/api/user-groups', {
        data: { name: group, members: [member], hiddenTabs: [] },
      })
      expect(lifted.status()).toBe(403)
      await page.getByRole('button', { name: '切断' }).click()

      // The fixture account is not a member and sees every tab.
      await login(page, t)
      await expect(
        page.getByRole('navigation', { name: 'サーバー' }).getByRole('link', { name: 'SQL', exact: true })
      ).toBeVisible()
      await page.goto('/user-groups')
      await page.getByRole('button', { name: `${group}: 削除` }).click()
      await expect(page.getByRole('button', { name: `${group}: 削除` })).toHaveCount(0)
    } finally {
      await dropAccount(page, member)
    }
  })
})
