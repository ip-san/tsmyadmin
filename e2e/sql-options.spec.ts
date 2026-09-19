import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, test } from './helpers.ts'

async function typeSql(page: Page, sql: string) {
  const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(sql)
}

const sqlUrl = (t: Target) => (t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)

async function api(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`sql options (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
      await page.goto(sqlUrl(t))
    })

    test('formats a statement into a line per clause', async ({ page }) => {
      await typeSql(page, 'select a, b from users where id > 1 and id < 9')
      await page.getByRole('button', { name: '整形' }).click()
      await expect(page.locator('.cm-line')).toHaveText([
        'select a,',
        '  b',
        'from users',
        'where id > 1',
        '  and id < 9',
      ])
    })

    test('binds :name placeholders from the options, quoting the values', async ({ page }) => {
      await typeSql(page, 'SELECT :who AS who, :n AS n')
      await page.getByText(/^実行のオプション/).click()
      await page.getByLabel('who の値').fill("O'Brien")
      await page.getByLabel('n の値').fill('42')
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      const result = page.getByRole('region', { name: '文 1' })
      await expect(result.getByRole('cell', { name: "O'Brien", exact: true })).toBeVisible()
      await expect(result.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    })

    test('rolls back at the end when asked, and reads foreign keys as unchecked when switched off', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const suffix = Date.now().toString(36)
      const parent = `e2e_op_p_${suffix}`
      const child = `e2e_op_c_${suffix}`
      await api(page, t, `CREATE TABLE ${parent} (id INT PRIMARY KEY)`)
      await api(
        page,
        t,
        `CREATE TABLE ${child} (id INT PRIMARY KEY, p INT, CONSTRAINT ${child}_fk FOREIGN KEY (p) REFERENCES ${parent} (id))`
      )
      try {
        await page.getByText(/^実行のオプション/).click()
        await page.getByLabel('終了時にロールバック').check()
        await typeSql(page, `INSERT INTO ${parent} VALUES (1)`)
        await page.getByRole('button', { name: '実行する', exact: true }).click()
        await expect(page.getByRole('region', { name: '文 2' })).toContainText('1 行')
        const count = await api(page, t, `SELECT COUNT(*) FROM ${parent}`)
        expect(count[0].result.rows[0][0]).toBe(0)

        await page.getByLabel('終了時にロールバック').uncheck()
        await page.getByLabel('外部キーを検査する').uncheck()
        await typeSql(page, `INSERT INTO ${child} VALUES (1, 999)`)
        await page.getByRole('button', { name: '実行する', exact: true }).click()
        await expect(page.getByRole('region', { name: '文 2' })).toContainText('1 行')
        const rows = await api(page, t, `SELECT COUNT(*) FROM ${child}`)
        expect(rows[0].result.rows[0][0]).toBe(1)
      } finally {
        await api(page, t, `DROP TABLE IF EXISTS ${child}`)
        await api(page, t, `DROP TABLE IF EXISTS ${parent}`)
      }
    })

    test('ends statements at the delimiter chosen (MySQL)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'DELIMITER is the mysql client’s')
      await page.getByText(/^実行のオプション/).click()
      await page.getByLabel('区切り文字').fill('$$')
      await typeSql(page, 'SELECT 1 AS a$$ SELECT 2 AS c$$')
      await page.getByRole('button', { name: '実行する', exact: true }).click()
      await expect(page.getByRole('region', { name: '文 1' })).toContainText('1 行')
      await expect(page.getByRole('region', { name: '文 2' })).toContainText('1 行')
      await expect(page.getByRole('region', { name: '文 3' })).toHaveCount(0)
    })
  })
}
