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
    })
  })
}
