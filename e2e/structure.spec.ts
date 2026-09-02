import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, tableUrl, test } from './helpers.ts'

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
      // A new table opens on its structure tab; the database list shows it too.
      await expect(page).toHaveURL(new RegExp(`/table/${table}/structure`))
      await page.goto(dbUrl)
      await expect(page.getByRole('table').first().getByRole('link', { name: table, exact: true })).toBeVisible()

      // add column
      await page.goto(tableUrl(t, table, '/structure'))
      await page.getByRole('button', { name: 'カラムを追加' }).click()
      await page.getByLabel('カラム名').fill('n')
      await page.getByLabel('型', { exact: true }).fill('INT')
      await page.getByRole('dialog').getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ADD COLUMN/)
      // CREATE statement section loads on demand.
      await page.getByRole('button', { name: `${table}: 定義を表示` }).click()
      await expect(page.locator('pre').filter({ hasText: /CREATE TABLE/ })).toBeVisible()
      await page.getByRole('button', { name: `${table}: 定義を隠す` }).click()
      const columns = page.getByRole('table', { name: 'カラム' })
      await expect(columns.getByRole('row').filter({ hasText: /^3n/ })).toBeVisible()

      // foreign key: n → users.id (INT ↔ INT; the column is nullable, so SET NULL is valid), then drop it
      await page.getByRole('button', { name: '外部キーを追加' }).click()
      const fkDialog = page.getByRole('dialog')
      await fkDialog.getByRole('group', { name: 'このテーブルのカラム' }).getByLabel('n', { exact: true }).check()
      await fkDialog.getByLabel('参照先テーブル').selectOption('users')
      await fkDialog.getByRole('group', { name: '参照先カラム' }).getByLabel('id', { exact: true }).check()
      await fkDialog.getByLabel('ON DELETE').selectOption('SET NULL')
      await fkDialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
      await confirmPreview(page, /ADD CONSTRAINT[\s\S]*FOREIGN KEY[\s\S]*ON DELETE SET NULL/)
      await expect(page.getByText(/「外部キーを追加」を実行しました/)).toBeVisible()
      const fks = page.getByRole('table', { name: '外部キー' })
      const fkName = `fk_${table}_n`
      await expect(fks.getByRole('row').filter({ hasText: fkName })).toContainText('users (id)')
      await page.getByRole('button', { name: `${fkName}: 外部キーを削除` }).click()
      await confirmPreview(page, /DROP (FOREIGN KEY|CONSTRAINT)/)
      await expect(fks.getByRole('row').filter({ hasText: fkName })).toHaveCount(0)

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
      await expect(page.getByText('全 1 行')).toBeVisible()
      await page.goto(tableUrl(t, table, '/operations'))
      // table comment + maintenance through the same preview flow
      await page.getByLabel('コメント').fill('from e2e')
      await page
        .getByRole('form', { name: 'テーブルオプション' })
        .getByRole('button', { name: '次へ（SQL を確認）' })
        .click()
      await confirmPreview(page, /COMMENT/)
      await page.getByRole('button', { name: t.dialect === 'mysql' ? 'ANALYZE TABLE' : 'ANALYZE', exact: true }).click()
      await confirmPreview(page, /ANALYZE/)
      await page.getByRole('button', { name: 'テーブルを空にする…' }).click()
      await confirmPreview(page, /TRUNCATE TABLE/, table)
      await page.goto(tableUrl(t, table))
      await expect(page.getByText('全 0 行')).toBeVisible()
      await page.goto(tableUrl(t, table, '/operations'))
      await page.getByRole('button', { name: 'テーブルを削除…' }).click()
      await confirmPreview(page, /DROP TABLE/, table)
      await expect(page).toHaveURL(new RegExp(`/db/${t.database}(\\?|$)`))
      await expect(page.getByRole('table').first().getByRole('link', { name: table, exact: true })).toHaveCount(0)
    })

    test('bulk-truncates and bulk-drops selected tables from the database structure page', async ({ page }) => {
      const stamp = Date.now().toString(36)
      const a = `e2e_bulk_a_${stamp}`
      const b = `e2e_bulk_b_${stamp}`
      await page.request.post(`/api/databases/${t.database}/sql`, {
        data: {
          sql: `CREATE TABLE ${a} (id INT PRIMARY KEY); CREATE TABLE ${b} (id INT PRIMARY KEY); INSERT INTO ${a} (id) VALUES (1)`,
          ...(t.schema ? { schema: t.schema } : {}),
        },
      })
      const dbUrl = t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`
      await page.goto(dbUrl)
      await page.getByLabel(`${a} を選択`).check()
      await page.getByLabel(`${b} を選択`).check()
      await expect(page.getByText('2 件のテーブルを選択中').first()).toBeVisible()
      await page.getByRole('button', { name: '選択したテーブルを空にする…' }).click()
      await confirmPreview(page, /TRUNCATE TABLE/, t.database)
      await page.goto(tableUrl(t, a))
      await expect(page.getByText('全 0 行')).toBeVisible()
      await page.goto(dbUrl)
      await page.getByLabel(`${a} を選択`).check()
      await page.getByLabel(`${b} を選択`).check()
      await page.getByRole('button', { name: '選択したテーブルを削除…' }).click()
      await confirmPreview(page, /DROP TABLE/, t.database)
      await expect(page.getByRole('link', { name: a, exact: true })).toHaveCount(0)
      await expect(page.getByRole('link', { name: b, exact: true })).toHaveCount(0)
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
      await page
        .getByRole('form', { name: 'テーブル名を変更' })
        .getByRole('button', { name: '次へ（SQL を確認）' })
        .click()
      await confirmPreview(page, /RENAME TABLE|RENAME TO/)
      await expect(page).toHaveURL(new RegExp(`/table/${table}_x`))
      await expect(page.getByRole('heading', { name: new RegExp(`${table}_x`) })).toBeVisible()
      await sql(`DROP TABLE ${table}_x`)

      await page.goto('/')
      await page.getByLabel('データベース名').fill(dbName)
      await page.getByRole('button', { name: 'データベースを作成' }).click()
      await confirmPreview(page, /CREATE DATABASE/)
      // A new database opens directly; the server list then offers to drop it.
      await expect(page).toHaveURL(new RegExp(`/db/${dbName}`))
      await page.goto('/')
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
      await page
        .getByRole('form', { name: 'テーブルをコピー' })
        .getByRole('button', { name: '次へ（SQL を確認）' })
        .click()
      await confirmPreview(page, /CREATE TABLE[\s\S]*LIKE/)
      await expect(page).toHaveURL(new RegExp(`/table/${copy}`))
      await expect(page.getByText('全 5 行')).toBeVisible()
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
