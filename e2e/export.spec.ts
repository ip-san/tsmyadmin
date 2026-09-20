import { expect } from '@playwright/test'
import { login, TARGETS, tableUrl, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`export (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('downloads a SQL dump of one table', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/export'))
      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe(`${t.database}_users.sql`)
      const body = await (await download.createReadStream())
        .toArray()
        .then((chunks) => Buffer.concat(chunks).toString('utf8'))
      expect(body).toMatch(/CREATE TABLE/i)
      expect(body).toContain('alice@example.com')
    })

    test('downloads a CSV with BOM and \\N for NULL', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/export'))
      await page.getByLabel('CSV', { exact: true }).check()
      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe(`${t.database}_users.csv`)
      const body = await (await download.createReadStream())
        .toArray()
        .then((chunks) => Buffer.concat(chunks).toString('utf8'))
      expect(body.startsWith('﻿id,name,email,age,created_at')).toBe(true)
      expect(body).toContain('2,Bob,bob@example.com,\\N,')
    })

    test('database-level export selects tables and blocks multi-table CSV', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/export?schema=${t.schema}` : `/db/${t.database}/export`)
      await page.getByLabel('users', { exact: true }).check()
      await page.getByLabel('posts', { exact: true }).check()
      await page.getByLabel('CSV', { exact: true }).check()
      await expect(page.getByText('CSV は 1 テーブルずつ')).toBeVisible()
      await expect(page.getByRole('button', { name: 'ダウンロード' })).toBeDisabled()
      await page.getByLabel('JSON', { exact: true }).check()
      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe(`${t.database}.json`)
      const body = JSON.parse(
        await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))
      )
      expect(Object.keys(body).sort()).toEqual(['posts', 'users'])
      expect(body.users).toHaveLength(5)

      // XML carries several tables the same way, one <table> each.
      await page.getByLabel('XML', { exact: true }).check()
      const xmlPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const xml = await xmlPromise
      expect(xml.suggestedFilename()).toBe(`${t.database}.xml`)
      const text = await (await xml.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
      expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
      expect(text.match(/<table name="(users|posts)">/g)).toHaveLength(2)
      expect(text.match(/<row>/g)?.length).toBeGreaterThanOrEqual(5)
    })

    test('downloads a spreadsheet file, and a gzip-compressed SQL dump named by a template', async ({ page }) => {
      await page.goto(tableUrl(t, 'users', '/export'))
      await page.getByLabel('OpenDocument スプレッドシート（ODS）').check()
      let downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const ods = await downloadPromise
      expect(ods.suggestedFilename()).toBe(`${t.database}_users.ods`)
      const head = await (await ods.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).subarray(0, 4))
      // A ZIP file (an OpenDocument file is one): PK\x03\x04.
      expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04])

      await page.getByLabel('SQL', { exact: true }).check()
      await page.getByLabel('圧縮').selectOption('gzip')
      await page.getByLabel('ファイル名のテンプレート').fill('backup-@TABLE@')
      await page.getByLabel('出力する行数').fill('2')
      downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const gz = await downloadPromise
      expect(gz.suggestedFilename()).toBe('backup-users.sql.gz')
      const bytes = await (await gz.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks))
      expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b])
    })

    test('lets several tables go out as CSV when each gets its own file', async ({ page }) => {
      await page.goto(t.schema ? `/db/${t.database}/export?schema=${t.schema}` : `/db/${t.database}/export`)
      await page.getByLabel('users', { exact: true }).check()
      await page.getByLabel('posts', { exact: true }).check()
      await page.getByLabel('CSV', { exact: true }).check()
      await expect(page.getByRole('button', { name: 'ダウンロード' })).toBeDisabled()
      await page.getByLabel('テーブルごとに別のファイルにする（zip にまとめます）').check()
      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'ダウンロード' }).click()
      const zip = await downloadPromise
      expect(zip.suggestedFilename()).toBe(`${t.database}.zip`)
    })

    test('format options: CSV without a header and fully quoted, compact JSON, XML with a view, structure only', async ({
      page,
    }) => {
      const read = async (action: () => Promise<void>) => {
        const pending = page.waitForEvent('download')
        await action()
        const file = await pending
        return (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))
      }
      const download = () => page.getByRole('link', { name: 'ダウンロード' }).click()

      await page.goto(tableUrl(t, 'users', '/export'))
      await page.getByLabel('CSV', { exact: true }).check()
      await page.getByLabel('1 行目にカラム名を書く').uncheck()
      await page.getByLabel('すべての値を引用符で囲む').check()
      const csv = await read(download)
      expect(csv.startsWith('\ufeff"1","Alice"')).toBe(true)
      expect(csv).not.toContain('"id"')
      // NULL stays the bare marker even when everything else is quoted.
      expect(csv).toContain('"2","Bob","bob@example.com",\\N,')

      await page.getByLabel('JSON', { exact: true }).check()
      await page.getByLabel('1 行に詰める').check()
      const json = await read(download)
      expect(json.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(json).users).toHaveLength(5)

      await page.getByLabel('XML', { exact: true }).check()
      await page.getByLabel('データ（行）').uncheck()
      const structure = await read(download)
      expect(structure).toContain('<structure>')
      expect(structure).toMatch(/<column name="id" type="[^"]+" nullable="false"[^>]* key="PRI"/)
      expect(structure).not.toContain('<row>')
      await page.getByLabel('データ（行）').check()
      await page.getByLabel('構造（カラムの一覧）').uncheck()
      await page.getByLabel('ビュー', { exact: true }).check()
      const withView = await read(download)
      expect(withView).toContain('<row>')
      expect(withView).not.toContain('<structure>')
      expect(withView).toContain('<view name="active_users">')

      // Neither part: refused before the download, in words.
      await page.getByLabel('データ（行）').uncheck()
      await expect(page.getByText('構造とデータの少なくとも一方を選んでください')).toBeVisible()
    })
  })
}
