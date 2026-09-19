import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

async function api(page: Page, t: Target, statement: string) {
  await page.request
    .post(`/api/databases/${t.database}/sql`, { data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) } })
    .catch(() => undefined)
}

const dropAccount = (page: Page, t: Target, name: string) =>
  api(page, t, t.dialect === 'mysql' ? `DROP USER IF EXISTS '${name}'@'%'` : `DROP ROLE IF EXISTS ${name}`)

for (const t of TARGETS) {
  test.describe(`account management (${t.dialect})`, () => {
    test('creates an account with a generated password, then locks, renames, copies and limits it', async ({
      page,
    }) => {
      test.setTimeout(90_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const name = `e2e_acc_${suffix}`
      const renamed = `${name}_rn`
      const copied = `${name}_cp`
      const at = (n: string) => (t.dialect === 'mysql' ? `${n}@%` : n)
      try {
        await page.goto('/users')
        await page.getByRole('button', { name: 'ユーザーを作成' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('ユーザー名').fill(name)
        await dialog.getByRole('button', { name: 'パスワードを生成' }).click()
        const generated = await dialog.getByLabel('生成したパスワード').textContent()
        expect(generated).toMatch(/^[A-Za-z0-9]{16}$/)
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await expect(page.getByRole('dialog').getByLabel('SQL')).not.toContainText(generated ?? 'x')
        await confirmPreview(page, /CREATE (USER|ROLE)/)
        await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()

        // Locked, then open again.
        const row = (n: string) =>
          page.getByRole('row').filter({ has: page.getByRole('cell', { name: n, exact: true }) })
        await page.getByRole('button', { name: `${at(name)}: ロック`, exact: true }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /ACCOUNT LOCK/ : /NOLOGIN/)
        await expect(row(name)).toContainText(t.dialect === 'mysql' ? 'LOCKED' : 'NOLOGIN')
        await page.getByRole('button', { name: `${at(name)}: ロック解除`, exact: true }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /ACCOUNT UNLOCK/ : /LOGIN/)

        // Limits: the connection limit on both; MySQL's hourly limits and SSL too.
        await page.getByRole('button', { name: `${at(name)}: 制限`, exact: true }).click()
        const limits = page.getByRole('form', { name: `${at(name)}: 制限` })
        await limits.getByLabel('同時接続数').fill('3')
        if (t.dialect === 'mysql') await limits.getByLabel('接続の要件').selectOption('SSL')
        await limits.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(
          page,
          t.dialect === 'mysql' ? /REQUIRE SSL[\s\S]*MAX_USER_CONNECTIONS 3/ : /CONNECTION LIMIT 3/
        )

        // Global privileges (MySQL) / role attributes (PostgreSQL).
        if (t.dialect === 'mysql') {
          await page.getByRole('button', { name: `${at(name)}: グローバル権限`, exact: true }).click()
          const global = page.getByRole('form', { name: `${at(name)}: グローバル権限` })
          await global.getByLabel('PROCESS', { exact: true }).check()
          await global.getByRole('button', { name: '次へ（SQL を確認）' }).click()
          await confirmPreview(page, /GRANT PROCESS ON \*\.\* TO/)
        } else {
          await page.getByRole('button', { name: `${at(name)}: ロールの属性`, exact: true }).click()
          const attributes = page.getByRole('form', { name: `${at(name)}: ロールの属性` })
          await attributes.getByLabel('CREATEDB', { exact: true }).check()
          await attributes.getByRole('button', { name: '次へ（SQL を確認）' }).click()
          await confirmPreview(page, /ALTER ROLE .* CREATEDB/)
          await expect(row(name)).toContainText('CREATEDB')
        }

        // The privileges leave as a file.
        await page.getByRole('button', { name: `${at(name)}: 権限を表示`, exact: true }).click()
        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: '権限を SQL でダウンロード' }).click()
        expect((await download).suggestedFilename()).toMatch(/\.sql$/)

        // Renamed, then copied with its privileges.
        await page.getByRole('button', { name: `${at(name)}: 名前を変更`, exact: true }).click()
        const rename = page.getByRole('form', { name: `${at(name)}: 名前を変更` })
        await rename.getByLabel('新しい名前').fill(renamed)
        await rename.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, t.dialect === 'mysql' ? /RENAME USER/ : /RENAME TO/)
        await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()

        await page.getByRole('button', { name: `${at(renamed)}: コピー`, exact: true }).click()
        const copy = page.getByRole('form', { name: `${at(renamed)}: コピー` })
        await copy.getByLabel('新しい名前').fill(copied)
        await copy.getByLabel('パスワード', { exact: true }).fill('pw-copy-1')
        await copy.getByLabel('パスワード（確認）').fill('pw-copy-1')
        await copy.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await expect(page.getByRole('dialog').getByLabel('SQL')).not.toContainText('pw-copy-1')
        await confirmPreview(page, t.dialect === 'mysql' ? /CREATE USER[\s\S]*GRANT/ : /CREATE ROLE[\s\S]*ALTER ROLE/)
        await expect(page.getByRole('cell', { name: copied, exact: true })).toBeVisible()
      } finally {
        for (const n of [name, renamed, copied]) await dropAccount(page, t, n)
      }
    })

    test('creates an account with a database of its own name and a wildcard grant (MySQL)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'A same-named database and a wildcard grant are MySQL’s')
      test.setTimeout(60_000)
      await login(page, t)
      const name = `e2e_own_${Date.now().toString(36)}`
      try {
        await page.goto('/users')
        await page.getByRole('button', { name: 'ユーザーを作成' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('ユーザー名').fill(name)
        await dialog.getByLabel('ホスト').selectOption('local')
        await dialog.getByLabel('パスワード', { exact: true }).fill('pw-own-1')
        await dialog.getByLabel('パスワード（確認）').fill('pw-own-1')
        await dialog.getByLabel('同じ名前のデータベースを作り、全権限を付与する').check()
        await dialog.getByLabel(/ワイルドカード/).check()
        await dialog.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, /CREATE USER[\s\S]*CREATE DATABASE[\s\S]*GRANT ALL[\s\S]*\\_%/)
        await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
      } finally {
        await api(page, t, `DROP USER IF EXISTS '${name}'@'localhost'`)
        await api(page, t, `DROP DATABASE IF EXISTS ${name}`)
      }
    })

    test('grants and revokes privileges on one routine from its row', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const account = `e2e_rp_${suffix}`
      const fn = `e2e_rf_${suffix}`
      await api(
        page,
        t,
        t.dialect === 'mysql' ? `CREATE USER '${account}'@'%' IDENTIFIED BY 'pw-1'` : `CREATE ROLE ${account}`
      )
      await api(
        page,
        t,
        t.dialect === 'mysql'
          ? `CREATE FUNCTION ${fn}(a INT) RETURNS INT DETERMINISTIC RETURN a`
          : `CREATE FUNCTION ${fn}(a integer) RETURNS integer LANGUAGE sql AS 'SELECT a'`
      )
      try {
        await page.goto(t.schema ? `/db/${t.database}/routines?schema=${t.schema}` : `/db/${t.database}/routines`)
        await page.getByRole('button', { name: `${fn}: 権限`, exact: true }).click()
        const form = page.getByRole('form', { name: `${fn}: 権限` })
        await form.getByLabel('アカウント').selectOption(t.dialect === 'mysql' ? `${account}@%` : account)
        await form.getByRole('button', { name: '付与', exact: true }).click()
        await confirmPreview(page, /GRANT EXECUTE ON (FUNCTION|PROCEDURE)/)

        await page.getByRole('button', { name: `${fn}: 権限`, exact: true }).click()
        const again = page.getByRole('form', { name: `${fn}: 権限` })
        await again.getByLabel('アカウント').selectOption(t.dialect === 'mysql' ? `${account}@%` : account)
        await again.getByRole('button', { name: '取り消し', exact: true }).click()
        await confirmPreview(page, /REVOKE EXECUTE ON/)
      } finally {
        await api(page, t, `DROP FUNCTION IF EXISTS ${fn}`)
        await dropAccount(page, t, account)
      }
    })
  })
}
