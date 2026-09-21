import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`server diagnostics (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('draws the monitor from the second reading and says what the log section can show', async ({ page }) => {
      await page.goto('/monitor')
      await page.getByLabel('更新間隔').selectOption('1')
      const title = t.dialect === 'mysql' ? 'クエリ数（1 秒あたり）' : 'トランザクション数（1 秒あたり）'
      await expect(page.getByRole('img', { name: title })).toBeVisible({ timeout: 15_000 })
      // Paused, nothing more is read; clearing empties the charts.
      await page.getByRole('button', { name: '一時停止', exact: true }).click()
      await expect(page.getByRole('button', { name: '再開', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '消去', exact: true }).click()
      await expect(page.getByRole('img', { name: title })).toHaveCount(0)
      // The logs: a table of statements or the reason there is none, whatever this server is set to.
      const logs = t.dialect === 'mysql' ? 'スロークエリログ' : '負荷の高い文（pg_stat_statements）'
      await expect(page.getByRole('heading', { name: '記録された文' })).toBeVisible()
      await expect(
        page
          .getByRole('table', { name: logs })
          .or(page.getByText(/無効です|ファイルに出力|権限がありません|使えません|記録はまだありません/))
          .first()
      ).toBeVisible()
    })

    test('offers the statements as they run, and previews the general log switch before touching it', async ({
      page,
    }) => {
      await page.goto('/monitor')
      await expect(page.getByRole('heading', { name: '実行された文（リアルタイム）' })).toBeVisible()
      // The stream, its "nothing yet", or the reason there is none — whatever this server is set to.
      await expect(
        page
          .getByRole('table', { name: '実行された文（リアルタイム）' })
          .or(page.getByText(/まだ実行された文はありません|無効です|ファイルに出力|権限がありません|使えません/))
          .first()
      ).toBeVisible({ timeout: 15_000 })
      if (t.dialect !== 'mysql') return
      // Turning the log on or off is server-wide: the SQL is shown first, and cancelling runs nothing.
      const button = page.getByRole('button', { name: /一般ログを(有効|無効)にする…/ })
      await button.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByLabel('SQL')).toContainText('general_log')
      await dialog.getByRole('button', { name: 'キャンセル' }).click()
      await expect(dialog).toHaveCount(0)
    })

    test('shows the InnoDB status, and the events of a binary log (MySQL)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'InnoDB and binary logs are MySQL / MariaDB features')
      await page.goto('/engines')
      await page.getByText('InnoDB の状態').click()
      await expect(
        page.getByLabel('InnoDB の状態', { exact: true }).or(page.getByText('PROCESS 権限が必要です'))
      ).toBeVisible()

      await page.goto('/replication')
      const show = page.getByRole('button', { name: /: イベントを見る$/ }).first()
      // MariaDB keeps no binary log until asked to.
      if ((await show.count()) === 0) return
      await show.click()
      await expect(
        page.getByRole('table', { name: /のイベント/ }).or(page.getByText('イベントを読む権限がありません'))
      ).toBeVisible()
    })

    test('previews replica controls with the password masked, and reports what a standalone server answers', async ({
      page,
    }) => {
      test.skip(t.dialect !== 'mysql', 'The replica controls run SQL that only MySQL / MariaDB has')
      await page.goto('/replication')
      await page.getByRole('button', { name: 'ソースを設定…' }).click()
      const form = page.getByRole('form', { name: 'ソースを設定…' })
      await form.getByLabel('ソースのホスト').fill('primary.example')
      await form.getByLabel('レプリケーション用ユーザー').fill('repl')
      await form.getByLabel('パスワード', { exact: true }).fill('secret-repl-pw')
      await form.getByLabel('パスワード（確認）').fill('secret-repl-pw')
      await form.getByLabel('GTID で自動的に位置を合わせる').check()
      await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByLabel('SQL')).toContainText(/(SOURCE|MASTER)_PASSWORD = '\*\*\*\*'/)
      await expect(dialog.getByLabel('SQL')).not.toContainText('secret-repl-pw')
      await dialog.getByRole('button', { name: 'キャンセル' }).click()

      // On a server that replicates nothing, starting the replica is refused with the server's own message.
      await page.getByRole('button', { name: '開始', exact: true }).click()
      await expect(page.getByRole('dialog').getByLabel('SQL')).toContainText('START REPLICA')
      await page.getByRole('dialog').getByRole('button', { name: '実行する' }).click()
      await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
    })
    test('creates a replica user through the preview, and reports whether this server can be a source', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const name = `e2e_repl_${Date.now().toString(36)}`
      const mysql = t.dialect === 'mysql'
      await page.goto('/replication')
      const settings = page.getByRole('table', { name: 'このサーバーをソースにする準備' })
      await expect(settings.getByRole('row', { name: new RegExp(mysql ? 'server_id' : 'wal_level') })).toBeVisible()
      try {
        await page.getByRole('button', { name: 'レプリカ用ユーザーを作成…' }).click()
        const form = page.getByRole('form', { name: 'レプリカ用ユーザーを作成…' })
        await form.getByLabel('ユーザー名').fill(name)
        await form.getByLabel('パスワード', { exact: true }).fill('repl-pw-1')
        await form.getByLabel('パスワード（確認）').fill('repl-pw-1')
        await form.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByLabel('SQL')).toContainText(mysql ? 'REPLICATION SLAVE' : 'REPLICATION')
        await expect(dialog.getByLabel('SQL')).not.toContainText('repl-pw-1')
        await dialog.getByRole('button', { name: '実行する' }).click()
        await expect(dialog).toBeHidden()
      } finally {
        await page.request.post('/api/users/execute', {
          data: { op: { op: 'dropUser', user: mysql ? { name, host: '%' } : { name } } },
        })
      }
    })
  })
}
