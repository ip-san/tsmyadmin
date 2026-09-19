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
  })
}
