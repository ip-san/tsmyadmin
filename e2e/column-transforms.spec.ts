import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

for (const t of TARGETS) {
  test.describe(`column transformations (${t.dialect})`, () => {
    test('show a binary column as its image, a column as links and JSON indented', async ({ page }) => {
      await login(page, t)
      const table = `e2e_tr_${Date.now().toString(36)}`
      const blob = t.dialect === 'mysql' ? 'BLOB' : 'BYTEA'
      const image = t.dialect === 'mysql' ? `FROM_BASE64('${PNG}')` : `decode('${PNG}', 'base64')`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, pic ${blob}, code VARCHAR(40), doc TEXT)`)
      await sql(
        page,
        t,
        `INSERT INTO ${table} VALUES (1, ${image}, 'a b', '{"k":[1,2]}'), (2, NULL, 'javascript:alert(1)', 'plain')`
      )
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '表示の変換' }) })
        await card.getByLabel('カラム', { exact: true }).selectOption('pic')
        await card.getByLabel('表示', { exact: true }).selectOption('image')
        await card.getByRole('button', { name: '設定する' }).click()
        await card.getByLabel('カラム', { exact: true }).selectOption('code')
        await card.getByLabel('表示', { exact: true }).selectOption('link')
        await card.getByLabel(/リンク先/).fill('https://shop.example/items/{value}')
        await card.getByRole('button', { name: '設定する' }).click()
        await card.getByLabel('カラム', { exact: true }).selectOption('doc')
        await card.getByLabel('表示', { exact: true }).selectOption('json')
        await card.getByRole('button', { name: '設定する' }).click()
        await expect(card.getByRole('list', { name: '表示の変換' }).getByRole('listitem')).toHaveCount(3)

        await page.goto(tableUrl(t, table))
        const img = page.getByRole('img', { name: 'pic の画像' })
        await expect(img).toBeVisible()
        // Drawn, not just present: a data: URL the page's CSP refused would leave it zero-sized.
        expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
        const link = page.getByRole('link', { name: /^a b/ })
        await expect(link).toHaveAttribute('href', 'https://shop.example/items/a%20b')
        await expect(link).toHaveAttribute('target', '_blank')
        // A hostile value goes into the template encoded: still a link to the same site, never a script URL.
        await expect(page.getByRole('link', { name: /javascript/ })).toHaveAttribute(
          'href',
          'https://shop.example/items/javascript%3Aalert(1)'
        )
        await expect(page.locator('pre').filter({ hasText: '"k"' })).toContainText('"k": [\n    1,')

        // Removing one puts the plain value back.
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByRole('button', { name: 'code: 解除' }).click()
        await page.goto(tableUrl(t, table))
        await expect(page.getByRole('cell', { name: 'a b', exact: true })).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('format values as an address, a yes / no, a date, a part and text around; and check what is typed', async ({
      page,
    }) => {
      test.setTimeout(90_000)
      await login(page, t)
      const table = `e2e_tf_${Date.now().toString(36)}`
      await sql(
        page,
        t,
        `CREATE TABLE ${table} (id INT PRIMARY KEY, ip BIGINT, flag INT, day VARCHAR(20), name VARCHAR(40), price INT, zip VARCHAR(20), doc TEXT)`
      )
      await sql(
        page,
        t,
        `INSERT INTO ${table} VALUES (1, 3232235777, 1, '2026-01-02 15:04:05', 'abcdef', 100, '123-4567', '{}')`
      )
      const setUp = async (
        card: ReturnType<Page['locator']>,
        column: string,
        kind: string,
        fill: Record<string, string> = {}
      ) => {
        await card.getByLabel('カラム', { exact: true }).selectOption(column)
        await card.getByLabel('表示', { exact: true }).selectOption({ label: kind })
        for (const [label, value] of Object.entries(fill)) await card.getByLabel(label, { exact: true }).fill(value)
        await card.getByRole('button', { name: '設定する' }).click()
      }
      try {
        await page.goto(tableUrl(t, table, '/structure'))
        const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '表示の変換' }) })
        await setUp(card, 'ip', 'IPv4 アドレス（整数から）')
        await setUp(card, 'flag', '真偽値（はい / いいえ）', { 真のとき: 'ON', 偽のとき: 'OFF' })
        await setUp(card, 'day', '日付の書式', { 書式: 'YYYY年M月D日 HH:mm' })
        await setUp(card, 'name', '一部だけ表示', { '開始位置（0 から）': '0', 長さ: '3' })
        await setUp(card, 'price', '前後に文字列を付ける', { 前に付ける文字列: '¥', 後ろに付ける文字列: '円' })
        await setUp(card, 'zip', '入力: 正規表現で検証', {
          正規表現: '^\\d{3}-\\d{4}$',
          合わないときの表示: '郵便番号の形式で入力してください',
        })
        await setUp(card, 'doc', '入力: JSON エディター')
        await expect(card.getByRole('list', { name: '表示の変換' }).getByRole('listitem')).toHaveCount(7)

        await page.goto(tableUrl(t, table))
        const row = page.getByRole('row').filter({ hasText: 'abc' })
        await expect(row).toContainText('192.168.1.1')
        await expect(row).toContainText('ON')
        await expect(row).toContainText('2026年1月2日 15:04')
        await expect(row).toContainText('abc…')
        await expect(row).toContainText('¥100円')
        // The value as stored is one hover away.
        await expect(row.getByTitle('abcdef')).toBeVisible()

        // The insert form checks a value against the pattern, and a JSON editor checks JSON.
        await page.goto(tableUrl(t, table, '/insert'))
        await page.getByLabel('id', { exact: true }).fill('2')
        await page.getByLabel('zip', { exact: true }).fill('12-345')
        await expect(page.getByText('郵便番号の形式で入力してください')).toBeVisible()
        expect(
          await page.getByLabel('zip', { exact: true }).evaluate((el) => (el as HTMLInputElement).validity.valid)
        ).toBe(false)
        await page.getByLabel('zip', { exact: true }).fill('123-4567')
        await expect(page.getByText('郵便番号の形式で入力してください')).toBeHidden()
        await page.getByLabel('doc', { exact: true }).fill('{not json')
        await expect(page.getByText('JSON として読めません')).toBeVisible()
        await page.getByLabel('doc', { exact: true }).fill('{"ok": true}')
        await expect(page.getByText('JSON として読めません')).toBeHidden()
        await page.getByRole('button', { name: '挿入する' }).click()
        await expect(page.getByText('1 行を挿入しました')).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })
  })
}
