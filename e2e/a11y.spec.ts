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

  test('user groups tab', async ({ page }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no target')
    await login(page, t)
    await page.goto('/user-groups')
    await page.getByRole('group', { name: '隠すタブ（テーブル）' }).waitFor()
    await scan(page)
  })

  test('tracking tab with a difference to show', async ({ page }) => {
    const t = TARGETS[0]
    if (!t) throw new Error('no target')
    await login(page, t)
    const table = `e2e_a11ytr_${Date.now().toString(36)}`
    const run = (sql: string) => page.request.post(`/api/databases/${t.database}/sql`, { data: { sql } })
    await run(`CREATE TABLE ${table} (id INT PRIMARY KEY)`)
    try {
      await page.goto(tableUrl(t, table, '/tracking'))
      await page.getByRole('button', { name: /追跡を始める/ }).click()
      await run(`ALTER TABLE ${table} ADD COLUMN note INT`)
      await page.reload()
      await page.getByLabel(/違い（/).waitFor()
      await scan(page)
    } finally {
      await page.request.delete(`/api/databases/${t.database}/tables/${table}/tracking`)
      await run(`DROP TABLE IF EXISTS ${table}`)
    }
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
      // Two rows ticked, their actions shown, and the dialog that edits them together.
      const grid = page.getByRole('table', { name: 'users' })
      await grid.getByRole('row').nth(1).getByRole('checkbox').check()
      await grid.getByRole('row').nth(2).getByRole('checkbox').check()
      await page.getByRole('button', { name: 'このページのグラフ' }).click()
      await scan(page)
      await page.getByRole('button', { name: '選択行を編集' }).click()
      await page.getByRole('dialog').getByLabel('name（2 行目）', { exact: true }).waitFor()
      await scan(page)
      await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()
      await page.goto(tableUrl(t, 'users', '/structure'))
      await page.getByRole('table', { name: 'カラム' }).waitFor()
      // The column dialog with every section open (key, collation, generated column).
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByRole('dialog').getByLabel('生成カラム（式から値を計算する）').check()
      await scan(page)
      await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()
      await page.getByText('正規化の手がかり').click()
      await page.getByText(/行から推定しています|行しかないため/).waitFor()
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
      // Zoom search with a plot, a picked row and the table of points open.
      await page.goto(tableUrl(t, 'users', '/search'))
      const zoom = page.getByRole('region', { name: 'ズーム検索' })
      await zoom.getByRole('button', { name: '散布図を表示' }).click()
      await zoom.getByText(/点を表で見る/).click()
      await zoom
        .getByRole('button', { name: /の行を選ぶ$/ })
        .first()
        .click()
      await zoom.getByRole('link', { name: 'この行を表示タブで開く' }).waitFor()
      await scan(page)
    })

    test('GIS view of a page of shapes', async ({ page }) => {
      await login(page, t)
      const table = `e2e_a11ygis_${Date.now().toString(36)}`
      const run = (sql: string) =>
        page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql, ...(t.schema ? { schema: t.schema } : {}) },
        })
      await run(`CREATE TABLE ${table} (id INT PRIMARY KEY, shape ${t.dialect === 'mysql' ? 'GEOMETRY' : 'POLYGON'})`)
      await run(
        t.dialect === 'mysql'
          ? `INSERT INTO ${table} VALUES (1, ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 0))'))`
          : `INSERT INTO ${table} VALUES (1, '((0,0),(1,0),(1,1))')`
      )
      try {
        await page.goto(tableUrl(t, table))
        await page.getByText('図形で表示（GIS）').click()
        await page.getByRole('img', { name: 'shape の図形 1 件' }).waitFor()
        await scan(page)
      } finally {
        await run(`DROP TABLE IF EXISTS ${table}`)
      }
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
      for (const path of ['/replication', '/collations', '/engines', '/plugins']) {
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
      // Central columns with one definition in the list (kept in this browser on this server).
      await page.goto(t.schema ? `/db/${t.database}/central?schema=${t.schema}` : `/db/${t.database}/central`)
      const add = page.locator('form').filter({ has: page.getByRole('button', { name: '追加する' }) })
      await add.getByLabel('カラム名').fill('created_at')
      await add.getByLabel('型', { exact: true }).fill('timestamp')
      await add.getByRole('button', { name: '追加する' }).click()
      await page.getByRole('table', { name: 'セントラルカラム' }).waitFor()
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
      // The docked console open under a page, with a result of its own.
      await page.getByRole('button', { name: 'コンソール', exact: true }).click()
      const dock = page.getByRole('region', { name: 'SQL コンソール（画面の下に常駐）' })
      await dock.getByRole('textbox', { name: 'SQL エディタ' }).click()
      await page.keyboard.type('SELECT 1 AS one')
      // Close the editor's completion popup (CodeMirror's own), which a slower machine may still be showing.
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox', { name: 'Completions' })).toHaveCount(0)
      await dock.getByRole('button', { name: '実行する', exact: true }).click()
      await dock.getByRole('region', { name: '文 1' }).waitFor()
      await scan(page)
      await dock.getByRole('button', { name: 'コンソールを閉じる' }).click()
      await page.goto(tableUrl(t, 'users', '/insert'))
      await page.getByRole('button', { name: '挿入する' }).waitFor()
      await scan(page)
      // Two rows at once, with a function chosen: every repeated control still has a name of its own.
      await page.getByLabel('一度に入れる行数').selectOption('2')
      await page.getByLabel('name（2 行目）: 関数').selectOption('upper')
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
