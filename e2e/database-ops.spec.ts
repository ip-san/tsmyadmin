import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

/** Runs SQL through the API as the logged-in browser session, failing the test on an HTTP error. */
async function sqlIn(page: Page, database: string, sql: string): Promise<void> {
  const res = await page.request.post(`/api/databases/${database}/sql`, { data: { sql } })
  expect(res.ok()).toBe(true)
}

/** A scratch database with one table and two rows, created from the session's own database. */
async function seedDatabase(page: Page, t: Target, name: string): Promise<void> {
  await sqlIn(page, t.database, `CREATE DATABASE ${name}`)
  // On PostgreSQL this opens a pooled connection to the new database: the rename below must still go through.
  await sqlIn(
    page,
    name,
    "CREATE TABLE items (id INT PRIMARY KEY, v VARCHAR(10)); INSERT INTO items VALUES (1, 'a'), (2, 'b')"
  )
}

async function dropQuietly(page: Page, t: Target, name: string): Promise<void> {
  const force = t.dialect === 'postgres' ? ' WITH (FORCE)' : ''
  await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: `DROP DATABASE IF EXISTS ${name}${force}` },
  })
}

for (const t of TARGETS) {
  test.describe(`database operations (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('renames a database, then copies it with its rows', async ({ page }) => {
      const base = `e2e_dbops_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const renamed = `${base}_ren`
      const copied = `${base}_cpy`
      await seedDatabase(page, t, base)
      try {
        await page.goto(`/db/${base}/operations`)
        await page.getByLabel('新しいデータベース名').fill(renamed)
        await page
          .getByRole('form', { name: 'データベースの名前を変更' })
          .getByRole('button', { name: '次へ（SQL を確認）' })
          .click()
        // MySQL moves the tables and keeps the old database: dropping it would also take what the account cannot
        // see, or what was created after this preview.
        if (t.dialect === 'mysql') {
          const statements = page.getByRole('dialog').getByLabel('SQL')
          // Wait for the SQL first, or the negative check could pass against an empty dialog.
          await expect(statements).toContainText('RENAME TABLE')
          await expect(statements).not.toContainText('DROP DATABASE')
        }
        await confirmPreview(page, t.dialect === 'mysql' ? /RENAME TABLE/ : /RENAME TO/, base)
        await expect(page).toHaveURL(new RegExp(`/db/${renamed}$`))
        await expect(page.getByRole('heading', { name: new RegExp(renamed) })).toBeVisible()
        await page.goto('/')
        await expect(page.getByRole('main').getByRole('link', { name: base, exact: true })).toHaveCount(
          t.dialect === 'mysql' ? 1 : 0
        )

        await page.goto(`/db/${renamed}/operations`)
        // PostgreSQL copies from a template no one is using: this page's own requests to the database (the tree,
        // the table list) finish first, as a person reading the form would let them.
        await page.waitForLoadState('networkidle')
        await page.getByLabel('コピー先のデータベース名').fill(copied)
        await page
          .getByRole('form', { name: 'データベースをコピー' })
          .getByRole('button', { name: '次へ（SQL を確認）' })
          .click()
        await confirmPreview(page, t.dialect === 'mysql' ? /INSERT INTO/ : /TEMPLATE/)
        await expect(page).toHaveURL(new RegExp(`/db/${copied}$`))
        await page.goto(`/db/${copied}/table/items${t.schema ? `?schema=${t.schema}` : ''}`)
        await expect(page.getByText('全 2 行')).toBeVisible()
      } finally {
        for (const name of [base, renamed, copied]) await dropQuietly(page, t, name)
      }
    })

    test('copies the foreign keys and AUTO_INCREMENT counters when asked (MySQL)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'PostgreSQL copies from a template, which keeps them')
      const base = `e2e_dbkeep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      // The form's own default name for the copy.
      const copied = `${base}_copy`
      await sqlIn(page, t.database, `CREATE DATABASE ${base}`)
      await sqlIn(
        page,
        base,
        'CREATE TABLE parent (id INT AUTO_INCREMENT PRIMARY KEY); CREATE TABLE child (id INT PRIMARY KEY, p INT, CONSTRAINT child_p FOREIGN KEY (p) REFERENCES parent (id)); INSERT INTO parent VALUES (1); ALTER TABLE parent AUTO_INCREMENT = 700'
      )
      try {
        await page.goto(`/db/${base}/operations`)
        const form = page.getByRole('form', { name: 'データベースをコピー' })
        await form.getByLabel('外部キーもコピーする').check()
        await form.getByLabel('次の AUTO_INCREMENT 値も引き継ぐ').check()
        await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /AUTO_INCREMENT = 700[\s\S]*FOREIGN KEY[\s\S]*REFERENCES `[^`]+_copy`\.`parent`/)
        const structure = await (await page.request.get(`/api/databases/${copied}/tables/child/structure`)).json()
        expect(structure.foreignKeys[0]).toMatchObject({ refTable: 'parent', refNamespace: { database: copied } })
      } finally {
        await dropQuietly(page, t, copied)
        await dropQuietly(page, t, base)
      }
    })

    test('does not offer to rename the server’s own databases', async ({ page }) => {
      await page.goto(`/db/${t.dialect === 'mysql' ? 'mysql' : 'postgres'}/operations`)
      await expect(page.getByText('サーバー自身のデータベースは、名前変更もコピーもできません。')).toBeVisible()
      await expect(page.getByRole('form', { name: 'データベースの名前を変更' })).toHaveCount(0)
      if (t.dialect === 'postgres') {
        // PostgreSQL cannot rename or copy the database a statement runs in: the session's own is refused up front.
        await page.goto(`/db/${t.database}/operations`)
        await expect(page.getByText(/このセッションが接続しているデータベース/)).toBeVisible()
      }
    })
  })
}
