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
      await page.getByRole('button', { name: '一時停止' }).click()
      await expect(page.getByRole('button', { name: '再開' })).toBeVisible()
      await page.getByRole('button', { name: '消去' }).click()
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
  })
}
