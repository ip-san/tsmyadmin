import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

const setting = (page: Page, key: string, value: unknown) =>
  page.evaluate(([k, v]) => localStorage.setItem(`tsmyadmin.pref.${k}`, JSON.stringify(v)), [key, value] as const)

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

for (const t of TARGETS) {
  test.describe(`shell extras (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('the tree can be expanded, collapsed and reloaded, and resized from the keyboard', async ({ page }) => {
      const tree = page.getByRole('complementary', { name: /テーブル|ツリー|データベース/ })
      await expect(tree.getByRole('button', { name: 'すべて展開' })).toBeVisible()
      await tree.getByRole('button', { name: 'すべて展開' }).click()
      await tree.getByRole('button', { name: 'すべて折りたたむ' }).click()
      await tree.getByRole('button', { name: 'ツリーを再読み込み' }).click()

      const handle = page.getByRole('separator', { name: /サイドバーの幅/ })
      const before = Number(await handle.getAttribute('aria-valuenow'))
      await handle.focus()
      await page.keyboard.press('ArrowRight')
      await expect(handle).toHaveAttribute('aria-valuenow', String(before + 16))
      await page.keyboard.press('Home')
      await expect(handle).toHaveAttribute('aria-valuenow', '200')
    })

    test('single keys jump between the tabs of the level, and the manual is one click away', async ({ page }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      await page.keyboard.press('s')
      await expect(page).toHaveURL(/\/table\/users\/sql/)
      await page.locator('body').click({ position: { x: 5, y: 5 } })
      await page.keyboard.press('t')
      await expect(page).toHaveURL(/\/table\/users\/structure/)
      const manual = page.getByRole('link', { name: 'マニュアル' })
      await expect(manual).toHaveAttribute('href', /^https:\/\/(dev\.mysql\.com|www\.postgresql\.org|mariadb\.com)\//)
      await page.keyboard.press('h')
      await expect(page).toHaveURL('/')
    })

    test('the settings for this page open at their section, and Enter runs when asked to', async ({ page }) => {
      await page.goto(`/db/${t.database}${t.schema ? `?schema=${t.schema}` : ''}`)
      await page.getByRole('link', { name: 'このページに関わる設定' }).click()
      await expect(page).toHaveURL(/\/settings#navigation/)

      await setting(page, 'sql.enterRuns', true)
      await page.goto(`/db/${t.database}/sql${t.schema ? `?schema=${t.schema}` : ''}`)
      const editor = page.locator('.cm-content')
      await editor.click()
      await page.keyboard.type('SELECT 41 + 1 AS answer')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
      // Shift + Enter stays a new line.
      await editor.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Shift+Enter')
      await expect(editor.locator('.cm-line')).toHaveCount(2)
    })

    test('a table opens on the tab that was chosen, and a cell edits with one click when asked', async ({ page }) => {
      await setting(page, 'tab.table', 'structure')
      await page.goto(`/db/${t.database}${t.schema ? `?schema=${t.schema}` : ''}`)
      await page.getByRole('complementary').getByRole('link', { name: 'users', exact: true }).click()
      await expect(page).toHaveURL(/\/table\/users\/structure/)

      await setting(page, 'grid.edit', 'click')
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      await page.locator('[data-cell="0,1"]').click()
      await expect(page.getByRole('textbox', { name: /編集/ })).toBeVisible()
    })

    test('shows an image only from an allowed host, and HTML only as its safe parts', async ({ page }) => {
      test.setTimeout(60_000)
      await page.route('https://img.e2e.test/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }))
      const table = `e2e_tx_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, pic VARCHAR(100), doc VARCHAR(200))`)
      await sql(
        page,
        t,
        `INSERT INTO ${table} VALUES (1, 'https://img.e2e.test/a.png', '<b>bold</b><img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">x</a>'), (2, 'https://evil.e2e.test/a.png', 'plain')`
      )
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '表示の変換' }) })
        await card.getByLabel('カラム', { exact: true }).selectOption('pic')
        await card.getByLabel('表示', { exact: true }).selectOption('imagelink')
        await card.getByRole('button', { name: '設定する' }).click()
        await card.getByLabel('カラム', { exact: true }).selectOption('doc')
        await card.getByLabel('表示', { exact: true }).selectOption('html')
        await card.getByRole('button', { name: '設定する' }).click()

        await page.goto(tableUrl(t, table))
        const images = page.getByRole('img', { name: 'pic の画像' })
        await expect(images).toHaveCount(1)
        await expect.poll(() => images.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
        // The other host is a link, not a picture.
        await expect(page.getByRole('link', { name: /evil\.e2e\.test/ })).toBeVisible()

        await expect(page.locator('b', { hasText: 'bold' })).toBeVisible()
        const doc = page.getByRole('cell').filter({ has: page.locator('b', { hasText: 'bold' }) })
        await expect(doc.locator('img, script')).toHaveCount(0)
        await expect(doc.getByRole('link')).toHaveCount(0)
        await expect(doc).not.toContainText('alert')
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('writes an IPv4 address typed into the form as its integer', async ({ page }) => {
      test.setTimeout(60_000)
      const table = `e2e_ip_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, ip BIGINT)`)
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '表示の変換' }) })
        await card.getByLabel('カラム', { exact: true }).selectOption('ip')
        await card.getByLabel('表示', { exact: true }).selectOption('ipv4-to-int')
        await card.getByRole('button', { name: '設定する' }).click()
        await page.goto(tableUrl(t, table, '/insert'))
        await page.getByLabel('id', { exact: true }).fill('1')
        await page.getByLabel('ip', { exact: true }).fill('192.168.0.1')
        await page.getByRole('button', { name: /^挿入する$|^挿入$/ }).click()
        await expect
          .poll(async () => String((await sql(page, t, `SELECT ip FROM ${table}`))[0]?.result?.rows?.[0]?.[0]))
          .toBe('3232235521')
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('warns before the session ends and keeps it on request', async ({ page }) => {
      await page.clock.install()
      await page.goto('/')
      await page.getByRole('heading', { name: 'サーバー', exact: true }).waitFor()
      await page.clock.fastForward('29:00')
      await expect(page.getByText(/セッションが切れます/)).toBeVisible()
      await page.getByRole('button', { name: 'セッションを延長' }).click()
      await expect(page.getByText(/セッションが切れます/)).toHaveCount(0)
    })
  })
}
