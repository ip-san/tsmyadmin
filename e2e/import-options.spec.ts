import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  const mysql = t.dialect === 'mysql'
  const inDb = (sql: string) =>
    ({ data: { sql, ...(t.schema ? { schema: t.schema } : {}) } }) as { data: { sql: string; schema?: string } }

  test.describe(`import and export options (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('creates a table from a spreadsheet the export wrote, then loads a gzip file over duplicates', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const suffix = Date.now().toString(36)
      const created = `e2e_ods_${suffix}`
      const keyed = `e2e_dup_${suffix}`
      const importUrl = t.schema ? `/db/${t.database}/import?schema=${t.schema}` : `/db/${t.database}/import`
      try {
        const ods = await page.request.get(
          `/api/databases/${t.database}/export?tables=users&format=ods${t.schema ? `&schema=${t.schema}` : ''}`
        )
        expect(ods.ok()).toBe(true)
        await page.goto(importUrl)
        await page.getByLabel('ファイル', { exact: true }).setInputFiles({
          name: 'users.ods',
          mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
          buffer: Buffer.from(await ods.body()),
        })
        await expect(page.getByRole('radio', { name: /^ODS/ })).toBeChecked()
        await page.getByLabel('ファイルの内容からテーブルを作って取り込む').check()
        await page.getByLabel('新しいテーブルの名前').fill(created)
        await page.getByRole('button', { name: 'インポートする' }).click()
        await expect(page.getByText(new RegExp(`${created} に \\d+ 行を挿入しました`))).toBeVisible()
        await expect(page.getByText(/テーブルを作成しました/)).toBeVisible()

        // A compressed CSV whose rows collide with what is there: left out, then replaced.
        await page.request.post(
          `/api/databases/${t.database}/sql`,
          inDb(`CREATE TABLE ${keyed} (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO ${keyed} VALUES (1, 'old')`)
        )
        await page.goto(importUrl)
        const csv = gzipSync(Buffer.from("id;name\n1;'new'\n2;'two'\n"))
        await page
          .getByLabel('ファイル', { exact: true })
          .setInputFiles({ name: 'rows.csv.gz', mimeType: 'application/gzip', buffer: csv })
        await expect(page.getByRole('radio', { name: 'CSV', exact: true })).toBeChecked()
        await page.getByLabel('取り込み先テーブル').selectOption(keyed)
        await page.getByLabel('区切り文字').fill(';')
        await page.getByLabel('囲み文字').fill("'")
        await page.getByLabel('主キー・一意キーが重複した行').selectOption('ignore')
        await page.getByRole('button', { name: 'インポートする' }).click()
        await expect(page.getByText(`${keyed} に 1 行を挿入しました`)).toBeVisible()
        const rows = await page.request.get(
          `/api/databases/${t.database}/tables/${keyed}/rows${t.schema ? `?schema=${t.schema}` : ''}`
        )
        expect(JSON.stringify((await rows.json()).rows)).toContain('old')

        await page.getByLabel('主キー・一意キーが重複した行').selectOption('replace')
        await page
          .getByLabel('ファイル', { exact: true })
          .setInputFiles({ name: 'rows.csv.gz', mimeType: 'application/gzip', buffer: csv })
        await page.getByLabel('取り込み先テーブル').selectOption(keyed)
        await page.getByRole('button', { name: 'インポートする' }).click()
        await expect(page.getByText(new RegExp(`${keyed} に \\d+ 行を挿入しました`))).toBeVisible()
        const replaced = await page.request.get(
          `/api/databases/${t.database}/tables/${keyed}/rows${t.schema ? `?schema=${t.schema}` : ''}`
        )
        expect(JSON.stringify((await replaced.json()).rows)).toContain('new')
      } finally {
        for (const name of [created, keyed])
          await page.request.post(`/api/databases/${t.database}/sql`, inDb(`DROP TABLE IF EXISTS ${name}`))
      }
    })

    test('exports several databases at the server level and runs a script there', async ({ page }) => {
      test.setTimeout(60_000)
      const name = `e2e_srvio_${Date.now().toString(36)}`
      // MySQL dumps databases, PostgreSQL the schemas of the connected database.
      const kind = mysql ? 'DATABASE' : 'SCHEMA'
      const cleanup = () =>
        page.request.post(
          `/api/databases/${t.database}/sql`,
          inDb(mysql ? `DROP DATABASE IF EXISTS ${name}` : `DROP SCHEMA IF EXISTS ${name} CASCADE`)
        )
      try {
        await page.goto('/server-import')
        const script = `CREATE ${kind} ${name};\nCREATE TABLE ${name}.t (id INT PRIMARY KEY);\nINSERT INTO ${name}.t VALUES (1), (2);\n`
        await page
          .getByLabel('ファイル', { exact: true })
          .setInputFiles({ name: 'server.sql', mimeType: 'text/plain', buffer: Buffer.from(script) })
        await expect(page.getByRole('radio')).toHaveCount(0)
        await page.getByRole('button', { name: 'インポートする' }).click()
        await expect(page.getByText('3 文成功、0 文失敗')).toBeVisible()

        await page.goto('/server-export')
        await page.getByLabel(name, { exact: true }).check()
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('link', { name: 'ダウンロードする' }).click(),
        ])
        expect(download.suggestedFilename()).toMatch(/\.sql$/)
        const text = await readFile(await download.path(), 'utf8')
        expect(text).toContain(
          mysql ? `CREATE DATABASE IF NOT EXISTS \`${name}\`` : `CREATE SCHEMA IF NOT EXISTS "${name}"`
        )
        expect(text).toContain('INSERT INTO')
      } finally {
        await cleanup()
      }
    })

    test('loads the fields into the columns it is told to, and reads only the chosen line ending as a record end', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const table = `e2e_map_${Date.now().toString(36)}`
      const importUrl = t.schema ? `/db/${t.database}/import?schema=${t.schema}` : `/db/${t.database}/import`
      await page.request.post(
        `/api/databases/${t.database}/sql`,
        inDb(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(40), note VARCHAR(40))`)
      )
      try {
        await page.goto(importUrl)
        // Fields are (name, skipped, id); the file has no header row and ends its records with LF only.
        await page.getByLabel('ファイル', { exact: true }).setInputFiles({
          name: 'rows.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('Alice,x,1\nBob\r,y,2\n'),
        })
        await page.getByLabel('取り込み先テーブル').selectOption(table)
        await page.getByLabel('1 行目をカラム名として扱う').uncheck()
        await page.getByLabel('行の終わり').selectOption('lf')
        await page.getByLabel(/カラムの対応/).fill('name, , id')
        await page.getByRole('button', { name: 'インポートする' }).click()
        await expect(page.getByText(`${table} に 2 行を挿入しました`)).toBeVisible()
        const rows = await page.request.get(
          `/api/databases/${t.database}/tables/${table}/rows${t.schema ? `?schema=${t.schema}` : ''}`
        )
        const cells = (await rows.json()).rows as (string | number | null)[][]
        expect(cells.map((r) => r.slice(0, 2)).sort()).toEqual([
          [1, 'Alice'],
          [2, 'Bob\r'],
        ])
        expect(cells.every((r) => r[2] === null)).toBe(true)
      } finally {
        await page.request.post(`/api/databases/${t.database}/sql`, inDb(`DROP TABLE IF EXISTS ${table}`))
      }
    })
  })
}
