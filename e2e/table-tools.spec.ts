import { expect, type Page } from '@playwright/test'
import { login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`table tools (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('shows the distinct values of a column with how many rows hold each', async ({ page }) => {
      const table = `e2e_dist_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, colour VARCHAR(10))`)
      try {
        await sql(page, t, `INSERT INTO ${table} VALUES (1, 'red'), (2, 'blue'), (3, 'red'), (4, NULL), (5, 'red')`)
        await page.goto(tableUrl(t, table, '/structure'))
        await page.getByRole('button', { name: 'colour: 個別の値' }).click()
        const values = page.getByRole('table', { name: 'colour の個別の値' })
        await expect(values.getByRole('row').nth(1)).toContainText('red')
        await expect(values.getByRole('row').nth(1)).toContainText('3')
        await expect(values.getByRole('row')).toHaveCount(4)
        await expect(values.getByRole('row', { name: /NULL/ })).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('counts the rows without a parent per foreign key and opens them in the SQL tab', async ({ page }) => {
      const id = Date.now().toString(36)
      const parent = `e2e_rip_${id}`
      const child = `e2e_ric_${id}`
      const mysql = t.dialect === 'mysql'
      await sql(page, t, `CREATE TABLE ${parent} (id INT PRIMARY KEY)`)
      await sql(page, t, `CREATE TABLE ${child} (id INT PRIMARY KEY, pid INT)`)
      try {
        await sql(page, t, `INSERT INTO ${parent} VALUES (1)`)
        await sql(page, t, `INSERT INTO ${child} VALUES (1, 1), (2, 9), (3, NULL)`)
        await sql(
          page,
          t,
          mysql
            ? `SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id)`
            : `ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id) NOT VALID`
        )
        await page.goto(tableUrl(t, child, '/operations'))
        await page.getByRole('button', { name: '参照整合性を確認' }).click()
        const result = page.getByRole('table', { name: '参照整合性の確認' })
        await expect(result.getByRole('row', { name: new RegExp(`${child}_fk`) })).toContainText('1')
        await page.getByRole('button', { name: `${child}_fk: 親のない行を SQL タブで開く` }).click()
        await expect(page).toHaveURL(/\/sql/)
        await expect(page.locator('.cm-content')).toContainText('LEFT JOIN')
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${child}`)
        await sql(page, t, `DROP TABLE IF EXISTS ${parent}`)
      }
    })

    test('previews the INSERT, skips a refused row on request, and goes back to the rows afterwards', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const table = `e2e_ins_${Date.now().toString(36)}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20))`)
      try {
        await sql(page, t, `INSERT INTO ${table} VALUES (1, 'a')`)
        await page.goto(tableUrl(t, table, '/insert'))
        await page.getByLabel('id', { exact: true }).fill('5')
        await page.getByLabel('name', { exact: true }).fill("it's")
        await page.getByRole('button', { name: 'SQL をプレビュー' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByLabel('SQL')).toContainText('INSERT INTO')
        // The values are bound, not written into the statement.
        await expect(dialog.getByLabel('SQL')).not.toContainText("it's")
        await expect(dialog).toContainText(/バインドする値.*5.*it's/)
        await dialog.getByRole('button', { name: '閉じる' }).last().click()
        // Nothing was inserted by looking.
        const before = await sql(page, t, `SELECT COUNT(*) FROM ${table}`)
        expect(Number(before[0].result.rows[0][0])).toBe(1)

        // A duplicate key: an error, unless errors are ignored.
        await page.getByLabel('id', { exact: true }).fill('1')
        await page.getByRole('button', { name: /^挿入する$|^挿入$/ }).click()
        await expect(page.getByRole('alert')).toBeVisible()
        await page.getByLabel('エラーを無視して挿入する').check()
        await page.getByRole('button', { name: /^挿入する$|^挿入$/ }).click()
        await expect(page.getByText(/1 行は、サーバーが受け付けなかったため飛ばしました/)).toBeVisible()

        await page.getByLabel('挿入後').selectOption('browse')
        await page.getByLabel('id', { exact: true }).fill('2')
        await page.getByLabel('name', { exact: true }).fill('b')
        await page.getByRole('button', { name: /^挿入する$|^挿入$/ }).click()
        await expect(page).toHaveURL(new RegExp(`/table/${table}(\\?|$)`))
        await expect(page.getByRole('cell', { name: 'b', exact: true })).toBeVisible()
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('shows every row of a table once the setting offers it', async ({ page }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      // Off by default: no such button until the setting is on.
      await expect(page.getByRole('button', { name: 'すべて表示', exact: true })).toHaveCount(0)
      await page.evaluate(() => localStorage.setItem('tsmyadmin.pref.browse.unlimited', 'true'))
      await page.goto(tableUrl(t, 'users'))
      await page.getByRole('combobox', { name: '表示行数' }).selectOption('25')
      await page.getByRole('button', { name: 'すべて表示', exact: true }).click()
      await expect(page.getByText('5 行を表示中')).toBeVisible()
      await expect(page.getByRole('combobox', { name: '表示行数' })).toHaveCount(0)
      await page.getByRole('button', { name: 'ページ表示に戻す' }).click()
      await expect(page.getByRole('combobox', { name: '表示行数' })).toBeVisible()
    })

    test('shows where the time goes for the page’s statement (MySQL only)', async ({ page }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      const toggle = page.getByLabel('実行の内訳（プロファイル）を見る')
      if (t.dialect !== 'mysql') {
        await expect(toggle).toHaveCount(0)
        return
      }
      await toggle.check()
      const statement = page.getByRole('figure', { name: /実行した SQL/ })
      await statement
        .getByText(/内訳|プロファイル/)
        .first()
        .click()
      await expect(statement.getByRole('table')).toBeVisible()
      await toggle.uncheck()
      await expect(statement.getByRole('table')).toHaveCount(0)
    })

    test('carries on from the statement behind the rows: edit, explain, code, bookmark, run again', async ({
      page,
    }) => {
      await page.goto(tableUrl(t, 'users'))
      await page.getByText('全 5 行').waitFor()
      const statement = page.getByRole('figure', { name: /実行した SQL/ })
      // A filter, so a value is bound: the actions take the statement with it written in.
      await page.goto(tableUrl(t, 'users', '/search'))
      await page.getByLabel('age: 条件').selectOption('gt')
      await page.getByLabel('age: 値').fill('30')
      await page.getByRole('button', { name: '検索する' }).click()
      await expect(page.getByText('全 2 行')).toBeVisible()
      await expect(statement.locator('pre')).not.toContainText('30')

      await statement.getByRole('button', { name: /コードにする/ }).click()
      await expect(page.getByRole('dialog').locator('pre')).toContainText(/`?"?age`?"? > .*30/)
      await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).first().click()

      await statement.getByRole('button', { name: /ブックマーク/ }).click()
      await expect(statement).toContainText('ブックマークに保存しました')

      await statement.getByRole('button', { name: /再実行/ }).click()
      await expect(page.getByText('全 2 行')).toBeVisible()

      await statement.getByRole('button', { name: /EXPLAIN/ }).click()
      await expect(page).toHaveURL(/\/sql/)
      await expect(page.locator('.cm-content')).toContainText(/EXPLAIN SELECT[\s\S]*> .*30/)
    })
  })
}
