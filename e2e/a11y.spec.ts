import AxeBuilder from '@axe-core/playwright'
import { expect } from '@playwright/test'
import { login, PASSKEY_BASE_URL, PERSISTENT_BASE_URL, TARGETS, tableUrl, test } from './helpers.ts'
import { createAccount, dropAccount, enrol, t as first, signIn } from './two-factor.ts'

async function scan(page: Parameters<typeof login>[0]) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
}

test.describe('accessibility (axe-core)', () => {
  test('login form (with presets and manual entry)', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('ホスト').waitFor()
    await scan(page)
    await page.getByLabel('接続先').selectOption('')
    await scan(page)
  })
})

test.describe('accessibility (axe-core, dark theme)', () => {
  test('login, browse and structure in dark mode', async ({ page }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no target')
    await page.addInitScript(() => localStorage.setItem('tsmyadmin.theme', 'dark'))
    await page.goto('/login')
    await page.getByLabel('ホスト').waitFor()
    await scan(page)
    await login(page, t)
    await page.goto(tableUrl(t, 'users'))
    await page.getByText('全 5 行').waitFor()
    await scan(page)
    await page.goto(tableUrl(t, 'users', '/structure'))
    await page.getByRole('table', { name: 'カラム' }).waitFor()
    await scan(page)
    await page.goto(tableUrl(t, 'users', '/operations'))
    await page.getByRole('button', { name: 'テーブルを削除…' }).click()
    await page.getByRole('dialog').getByLabel('SQL').waitFor()
    await scan(page)
  })
})

test.describe('accessibility (axe-core, two-factor)', () => {
  // The page only offers enrolment where the session store can keep a secret.
  test.use({ baseURL: PERSISTENT_BASE_URL })

  test('security tab, before and during enrolment', async ({ page }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no target')
    await login(page, t)
    await page.goto('/security')
    await page.getByRole('button', { name: '認証アプリで登録する' }).click()
    // Nothing is kept until a code confirms it, so the shared fixture account is left as it was.
    await page.locator('#second-factor-secret').waitFor()
    await scan(page)
  })

  test('users tab with an account to reset, and the reset dialog', async ({ page }) => {
    test.setTimeout(90_000)
    const name = `e2e_a11y2f_${Date.now().toString(36)}`
    await createAccount(page, name, 'pw-a11y-2fa')
    try {
      await signIn(page, name, 'pw-a11y-2fa')
      await enrol(page)
      await page.getByRole('button', { name: '切断' }).click()
      await login(page, first)
      await page.goto('/users')
      const reset = page.getByRole('button', {
        name: `${first.dialect === 'mysql' ? `${name}@%` : name}: 2 要素認証を解除…`,
      })
      await reset.waitFor()
      await scan(page)
      await reset.click()
      await page.getByRole('dialog').getByRole('button', { name: '解除する' }).waitFor()
      await scan(page)
      await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()
    } finally {
      await dropAccount(page, name)
    }
  })
})

test.describe('accessibility (axe-core, passkeys)', () => {
  test.use({ baseURL: PASSKEY_BASE_URL })

  test('security tab with a passkey, and the login asking for one', async ({ page }) => {
    test.setTimeout(90_000)
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
    const name = `e2e_a11ypk_${Date.now().toString(36)}`
    await createAccount(page, name, 'pw-a11y-pk')
    try {
      await signIn(page, name, 'pw-a11y-pk')
      await page.goto('/security')
      await page.getByRole('button', { name: 'パスキーで登録する' }).click()
      await page.getByRole('heading', { name: '回復用コード' }).waitFor()
      await scan(page)
      await page.getByRole('button', { name: '回復用コードを保管しました' }).click()
      await page.getByText(/パスキー 1（/).waitFor()
      await scan(page)
      await page.getByRole('button', { name: '切断' }).click()
      await signIn(page, name, 'pw-a11y-pk')
      await page.getByRole('button', { name: 'パスキーで確認' }).waitFor()
      await scan(page)
    } finally {
      await dropAccount(page, name)
    }
  })
})

// Both dialects: a few screens branch on the dialect (schema badge, event scheduler notice, ctid-less grids).
for (const t of TARGETS) {
  test.describe(`accessibility (axe-core, ${t.dialect})`, () => {
    test('server, database, browse and structure screens', async ({ page }) => {
      await login(page, t)
      await scan(page)
      await page.goto(`/db/${t.database}`)
      await page.getByRole('link', { name: 'users', exact: true }).first().waitFor()
      await scan(page)
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      await scan(page)
      await page.goto(tableUrl(t, 'users', '/structure'))
      await page.getByRole('table', { name: 'カラム' }).waitFor()
      await scan(page)
      // The query builder with a column row and a condition row, so every generated control is labelled.
      await page.goto(t.schema ? `/db/${t.database}/query?schema=${t.schema}` : `/db/${t.database}/query`)
      await page.getByRole('checkbox', { name: 'users', exact: true }).check()
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByRole('button', { name: '条件を追加' }).click()
      await page.getByLabel('グループ 1 の条件 1の値').waitFor()
      await scan(page)
      await page.goto(t.schema ? `/db/${t.database}/designer?schema=${t.schema}` : `/db/${t.database}/designer`)
      await page.getByRole('table', { name: '外部キー' }).waitFor()
      await scan(page)
    })

    test('server status, processes and users screens', async ({ page }) => {
      await login(page, t)
      await page.goto('/status')
      await page.getByRole('table', { name: 'ステータス変数' }).waitFor()
      await scan(page)
      await page.goto('/processes')
      await page.getByRole('table', { name: 'プロセス一覧' }).waitFor()
      await scan(page)
      await page.goto('/users')
      await page.getByRole('cell', { name: 'tsmyadmin', exact: true }).waitFor()
      await scan(page)
      // Collations, engines (access methods) and plugins (extensions): one table each, named per server.
      for (const path of ['/collations', '/engines', '/plugins']) {
        await page.goto(path)
        await page.getByRole('table').waitFor()
        await scan(page)
      }
      await page.goto(tableUrl(t, 'posts', '/privileges'))
      await page.getByRole('table', { name: 'posts の権限' }).getByText('サーバー全体').first().waitFor()
      await scan(page)
      await page.goto(`/db/${t.database}/export`)
      await page.getByRole('link', { name: 'ダウンロード' }).waitFor()
      await scan(page)
    })

    test('SQL console with results, insert form, events and dialogs', async ({ page }) => {
      await login(page, t)
      await page.goto(tableUrl(t, 'users', '/sql'))
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      await page.getByRole('region', { name: '文 1' }).waitFor()
      await scan(page)
      // With the chart open: its controls and legend are part of the page too.
      await page.getByRole('button', { name: '文 1 の結果: グラフ' }).click()
      await page.getByLabel('グラフの種類').waitFor()
      await scan(page)
      await page.goto(tableUrl(t, 'users', '/insert'))
      await page.getByRole('button', { name: '挿入する' }).waitFor()
      await scan(page)
      await page.goto(t.schema ? `/db/${t.database}/events?schema=${t.schema}` : `/db/${t.database}/events`)
      await page
        .getByRole('heading', { name: 'イベントスケジューラ' })
        .or(page.getByText(/イベントスケジューラがありません/))
        .first()
        .waitFor()
      await scan(page)
      await page.goto(tableUrl(t, 'users', '/operations'))
      await page.getByRole('button', { name: 'テーブルを削除…' }).click()
      await page.getByRole('dialog').getByLabel('SQL').waitFor()
      await scan(page)
    })
  })
}
