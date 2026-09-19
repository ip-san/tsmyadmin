import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`settings (${t.dialect})`, () => {
    test('are kept, take effect in the sidebar and the forms, travel in a file and reset', async ({ page }) => {
      test.setTimeout(90_000)
      const suffix = Date.now().toString(36)
      const one = `grp${suffix}_one`
      const two = `grp${suffix}_two`
      const inDb = (sql: string) => ({ data: { sql, ...(t.schema ? { schema: t.schema } : {}) } })
      try {
        await login(page, t)
        for (const name of [one, two])
          await page.request.post(`/api/databases/${t.database}/sql`, inDb(`CREATE TABLE ${name} (id INT)`))

        await page.getByRole('link', { name: '設定' }).click()
        await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible()
        await page.getByLabel('テーブル名をまとめる区切り').fill('_')
        await page.getByLabel('表の 1 ページの行数').fill('25')
        await page.getByLabel('SQL の履歴に残す件数').fill('30')
        // The export form starts from the format chosen here.
        await page.getByRole('radio', { name: 'JSON', exact: true }).check()
        await page.getByRole('button', { name: '保存する' }).click()
        await expect(page.getByText('保存しました。')).toBeVisible()
        await expect(page.getByLabel('表の 1 ページの行数')).toHaveValue('25')

        // Sidebar: the two tables sharing a prefix are under one entry that opens.
        await page.goto(t.schema ? `/db/${t.database}?schema=${t.schema}` : `/db/${t.database}`)
        const group = page.getByRole('button', { name: `grp${suffix}（2）` })
        await expect(group).toHaveAttribute('aria-expanded', 'false')
        await group.click()
        await expect(page.getByTitle(one)).toBeVisible()

        await page.goto(t.schema ? `/db/${t.database}/export?schema=${t.schema}` : `/db/${t.database}/export`)
        await expect(page.getByRole('radio', { name: 'JSON', exact: true })).toBeChecked()

        // The settings as a file, and back from it after a reset.
        await page.goto('/settings')
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: '設定をファイルに保存' }).click(),
        ])
        const file = await readFile(await download.path(), 'utf8')
        expect(JSON.parse(file)).toMatchObject({ browseLimit: 25, sqlHistoryMax: 30, navGroupDelimiter: '_' })
        await page.getByRole('button', { name: '既定に戻す' }).click()
        await page.getByRole('dialog').getByRole('button', { name: '既定に戻す' }).click()
        await expect(page.getByText('保存しました。')).toBeVisible()
        await expect(page.getByLabel('表の 1 ページの行数')).toHaveValue('50')
        await expect(page.getByLabel('テーブル名をまとめる区切り')).toHaveValue('')
        await page
          .getByLabel('設定ファイルを読み込む')
          .setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(file) })
        await expect(page.getByText('読み込みました。')).toBeVisible()
        await expect(page.getByLabel('表の 1 ページの行数')).toHaveValue('25')
        // A file that is not a settings file is refused, and nothing changes.
        await page
          .getByLabel('設定ファイルを読み込む')
          .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"browseLimit": 0}') })
        await expect(page.getByRole('alert')).toContainText('設定ファイルとして読めませんでした')
        await expect(page.getByLabel('表の 1 ページの行数')).toHaveValue('25')
      } finally {
        for (const name of [one, two])
          await page.request.post(`/api/databases/${t.database}/sql`, inDb(`DROP TABLE IF EXISTS ${name}`))
      }
    })
  })
}
