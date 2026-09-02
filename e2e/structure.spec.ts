import { expect, test } from '@playwright/test'
import { confirmPreview, login, TARGETS, tableUrl } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`structure / ddl (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('creates, alters, indexes, truncates and drops a table through previews', async ({ page }) => {
      const table = `e2e_ddl_${Date.now().toString(36)}`
      const dbUrl = t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`

      // create table (id auto-increment PK + name)
      await page.goto(dbUrl)
      await page.getByLabel('テーブル名').fill(table)
      await page.getByLabel('カラム名 2').fill('name')
      await page.getByLabel('型 2').fill('VARCHAR(50)')
      await page.getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /CREATE TABLE/)
      await expect(page.getByRole('table').first().getByRole('link', { name: table, exact: true })).toBeVisible()

      // add column
      await page.goto(tableUrl(t, table, '/structure'))
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('カラム名').fill('n')
      await page.getByLabel('型', { exact: true }).fill('INT')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ADD COLUMN/)
      const columns = page.getByRole('table', { name: 'カラム' })
      await expect(columns.getByRole('row').filter({ hasText: /^3n/ })).toBeVisible()

      // modify column: rename n → n2, BIGINT NOT NULL
      await page.getByRole('button', { name: 'n: 変更' }).click()
      await page.getByLabel('カラム名').fill('n2')
      await page.getByLabel('型', { exact: true }).fill('BIGINT')
      await page.getByLabel('NULL を許可').uncheck()
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ALTER TABLE/)
      await expect(columns.getByRole('row').filter({ hasText: 'n2' })).toContainText(/bigint/i)
      await expect(columns.getByRole('row').filter({ hasText: 'n2' })).toContainText('いいえ')

      // add + drop index
      await page.getByRole('button', { name: 'インデックスを追加' }).click()
      await page.getByRole('dialog').getByLabel('name', { exact: true }).check()
      await page.getByRole('dialog').getByLabel('ユニーク').check()
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /CREATE UNIQUE INDEX/)
      const indexes = page.getByRole('table', { name: 'インデックス' })
      const idxName = `idx_${table}_name`
      await expect(indexes.getByRole('row').filter({ hasText: idxName })).toContainText('はい')
      await page.getByRole('button', { name: `${idxName}: 削除` }).click()
      await confirmPreview(page, /DROP INDEX/)
      await expect(indexes.getByRole('row').filter({ hasText: idxName })).toHaveCount(0)

      // drop column
      await page.getByRole('button', { name: 'n2: 削除' }).click()
      await confirmPreview(page, /DROP COLUMN/)
      await expect(columns.getByRole('row').filter({ hasText: 'n2' })).toHaveCount(0)

      // insert a row, truncate, then drop
      await page.goto(tableUrl(t, table, '/insert'))
      await page.getByLabel('name: NULL').uncheck()
      await page.getByLabel('name', { exact: true }).fill('x')
      await page.getByRole('button', { name: '挿入する' }).click()
      await expect(page.getByText('1 行を挿入しました')).toBeVisible()
      await page.goto(tableUrl(t, table))
      await expect(page.getByText('全 1 件')).toBeVisible()
      await page.goto(tableUrl(t, table, '/operations'))
      await page.getByRole('button', { name: 'テーブルを空にする' }).click()
      await confirmPreview(page, /TRUNCATE TABLE/, table)
      await page.goto(tableUrl(t, table))
      await expect(page.getByText('全 0 件')).toBeVisible()
      await page.goto(tableUrl(t, table, '/operations'))
      await page.getByRole('button', { name: 'テーブルを削除' }).click()
      await confirmPreview(page, /DROP TABLE/, table)
      await expect(page).toHaveURL(new RegExp(`/db/${t.database}(\\?|$)`))
      await expect(page.getByRole('table').first().getByRole('link', { name: table, exact: true })).toHaveCount(0)
    })

    test('renames a table and creates/drops a database through previews', async ({ page }) => {
      const table = `e2e_rn_${Date.now().toString(36)}`
      const dbName = `e2e_db_${Date.now().toString(36)}`
      const sql = (s: string) =>
        page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql: s, ...(t.schema ? { schema: t.schema } : {}) },
        })
      await sql(`CREATE TABLE ${table} (id INT PRIMARY KEY)`)

      await page.goto(tableUrl(t, table, '/operations'))
      await page.getByLabel('新しいテーブル名').fill(`${table}_x`)
      await page.getByRole('button', { name: 'テーブル名を変更' }).click()
      await confirmPreview(page, /RENAME TABLE|RENAME TO/)
      await expect(page).toHaveURL(new RegExp(`/table/${table}_x`))
      await expect(page.getByRole('heading', { name: new RegExp(`${table}_x`) })).toBeVisible()
      await sql(`DROP TABLE ${table}_x`)

      await page.goto('/')
      await page.getByLabel('データベース名').fill(dbName)
      await page.getByRole('button', { name: 'データベースを作成' }).click()
      await confirmPreview(page, /CREATE DATABASE/)
      const row = page.getByRole('row').filter({ hasText: dbName })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: `${dbName}: データベースを削除` }).click()
      await confirmPreview(page, /DROP DATABASE/, dbName)
      await expect(page.getByRole('row').filter({ hasText: dbName })).toHaveCount(0)
    })

    test('copies a table with its data through the preview', async ({ page }) => {
      const copy = `e2e_users_copy_${Date.now().toString(36)}`
      await page.goto(tableUrl(t, 'users', '/operations'))
      await page.getByLabel('コピー先のテーブル名').fill(copy)
      await page.getByRole('button', { name: 'テーブルをコピー' }).click()
      await confirmPreview(page, /CREATE TABLE[\s\S]*LIKE/)
      await expect(page).toHaveURL(new RegExp(`/table/${copy}`))
      await expect(page.getByText('全 5 件')).toBeVisible()
      await page.request.post(`/api/databases/${t.database}/sql`, {
        data: { sql: `DROP TABLE ${copy}`, ...(t.schema ? { schema: t.schema } : {}) },
      })
    })

    test('lists routines and triggers with collapsible definitions', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/routines?schema=${t.schema}` : `/db/${t.database}/routines`)
      const routines = page.getByRole('table', { name: 'ストアドプロシージャ / 関数' })
      await expect(routines.getByRole('row').filter({ hasText: 'count_users' })).toContainText('プロシージャ')
      await expect(routines.getByRole('row').filter({ hasText: 'user_label' })).toContainText('関数')
      await page.getByRole('button', { name: 'user_label: 定義を表示' }).click()
      await expect(routines.getByText(/CREATE/i).first()).toBeVisible()

      await page.goto(tableUrl(t, 'posts', '/triggers'))
      const triggers = page.getByRole('table', { name: 'トリガー' })
      await expect(triggers.getByRole('row').filter({ hasText: 'posts_before_insert' })).toContainText('BEFORE')
      await page.getByRole('button', { name: 'posts_before_insert: 定義を表示' }).click()
      // MySQL shows the trigger body; PostgreSQL shows the CREATE TRIGGER statement (body lives in the function).
      await expect(triggers.getByText(t.dialect === 'mysql' ? /untitled/ : /posts_default_title/).first()).toBeVisible()
      await page.goto(tableUrl(t, 'users', '/triggers'))
      await expect(page.getByText('トリガーはありません')).toBeVisible()
    })

    test('event scheduler: lists events on MySQL, toggles status through previews; unsupported on PostgreSQL', async ({
      page,
    }) => {
      await page.goto(t.schema ? `/db/${t.database}/events?schema=${t.schema}` : `/db/${t.database}/events`)
      if (t.dialect === 'postgres') {
        await expect(page.getByText(/組み込みのイベントスケジューラがありません/)).toBeVisible()
        return
      }
      const table = page.getByRole('table', { name: 'イベントスケジューラ' })
      const row = table.getByRole('row').filter({ hasText: 'purge_old_posts' })
      await expect(row).toContainText('DISABLED')
      await expect(row).toContainText('EVERY 1 DAY')
      try {
        await page.getByRole('button', { name: 'purge_old_posts: 有効化' }).click()
        await confirmPreview(page, /ALTER EVENT[\s\S]*ENABLE/)
        await expect(row).toContainText('ENABLED')
        await page.getByRole('button', { name: 'purge_old_posts: 無効化' }).click()
        await confirmPreview(page, /ALTER EVENT[\s\S]*DISABLE/)
        await expect(row).toContainText('DISABLED')
      } finally {
        // A failure between the two toggles must not leave the fixture ENABLED for the next run.
        await page.request.post(`/api/databases/${t.database}/sql`, {
          data: { sql: 'ALTER EVENT purge_old_posts DISABLE' },
        })
      }
    })

    test('creates a schema on PostgreSQL from the database page', async ({ page }) => {
      test.skip(t.dialect !== 'postgres', 'schemas are a PostgreSQL concept')
      const schemaName = `e2e_schema_${Date.now().toString(36)}`
      await page.goto(`/db/${t.database}?schema=${t.schema}`)
      await page.getByLabel('スキーマ名').fill(schemaName)
      await page.getByRole('button', { name: 'スキーマを作成' }).click()
      await confirmPreview(page, /CREATE SCHEMA/)
      await expect(page.getByRole('button', { name: schemaName })).toBeVisible()
      await page.request.post(`/api/databases/${t.database}/sql`, { data: { sql: `DROP SCHEMA ${schemaName}` } })
    })

    test('shows the server error inside the preview dialog and keeps it open', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/structure'))
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('カラム名').fill('id')
      await page.getByLabel('型', { exact: true }).fill('INT')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: '実行する' }).click()
      await expect(dialog.getByRole('alert')).toContainText('失敗した文')
      await dialog.getByRole('button', { name: 'キャンセル' }).click()
      await expect(dialog).toBeHidden()
    })
  })
}
