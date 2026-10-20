import { statSync } from 'node:fs'
import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, tableUrl, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`table overview (${t.dialect})`, () => {
    test('says what a table is, what its columns hold, and what is a key away', async ({ page }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await sqlOn(page, space, 'CREATE TABLE owners (id INT PRIMARY KEY)')
        await sqlOn(
          page,
          space,
          'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, kind VARCHAR(10), note VARCHAR(10), FOREIGN KEY (owner_id) REFERENCES owners (id))'
        )
        await sqlOn(page, space, 'INSERT INTO owners VALUES (1), (2)')
        await sqlOn(
          page,
          space,
          "INSERT INTO pets VALUES (1, 1, 'cat', NULL), (2, 2, 'cat', NULL), (3, 1, 'cat', NULL)"
        )
        await sqlOn(page, space, 'CREATE VIEW cats AS SELECT id FROM pets')

        await page.goto(tableUrl(space, 'pets', '/overview'))
        await expect(page.getByText('ほかのテーブルを参照する、記録や明細のテーブルのようです')).toBeVisible()
        const columns = page.getByRole('table', { name: 'カラムごとの NULL の割合と値の種類' })
        const row = (name: string) =>
          columns.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })
        await expect(row('id')).toContainText('行ごとに違う値')
        await expect(row('kind')).toContainText('1 つの値だけ')
        await expect(row('note')).toContainText('すべて NULL')
        await expect(row('owner_id')).toContainText('2')
        await expect(page.getByText('全 3 行を数えました')).toBeVisible()
        await expect(page.getByRole('table', { name: '行の例' }).getByRole('row')).toHaveCount(4)
        await expect(page.getByRole('list', { name: 'つながるテーブルの外部キー' })).toContainText(
          'pets（owner_id）→ owners'
        )
        const usedBy = page.locator('section', { has: page.getByRole('heading', { name: 'これを使うもの' }) })
        await expect(usedBy.getByRole('listitem')).toHaveText(['ビュー cats'])

        // The table everything refers to.
        await page.goto(tableUrl(space, 'owners', '/overview'))
        await expect(page.getByText('ほかのテーブルから参照される、元になるテーブルのようです（マスタ）')).toBeVisible()
      })
    })

    test('presents a table: its key, what it refers to and what refers to it, and what is further', async ({
      page,
    }) => {
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        await sqlOn(page, space, 'CREATE TABLE orgs (id INT PRIMARY KEY)')
        await sqlOn(
          page,
          space,
          'CREATE TABLE owners (id INT PRIMARY KEY, org_id INT, FOREIGN KEY (org_id) REFERENCES orgs (id))'
        )
        await sqlOn(
          page,
          space,
          'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))'
        )
        await sqlOn(
          page,
          space,
          'CREATE TABLE visits (id INT PRIMARY KEY, pet_id INT, FOREIGN KEY (pet_id) REFERENCES pets (id))'
        )
        // Nothing plays by itself: the scenes are moved by hand.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(tableUrl(space, 'pets', '/overview'))
        await page.getByRole('button', { name: 'プレゼンで見る' }).click()
        const tour = page.getByRole('dialog', { name: 'テーブルのプレゼン: pets' })
        const title = tour.getByRole('heading', { level: 3 })
        await expect(title).toHaveText('pets')
        await page.keyboard.press('ArrowRight')
        await expect(tour.getByText('行は id で 1 つに決まります')).toBeVisible()
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('参照するテーブル（1）')
        await expect(tour.getByText('pets.owner_id が owners.id を参照', { exact: false })).toBeVisible()
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('参照してくるテーブル（1）')
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('2 段先のテーブル（1）')
        await expect(tour.getByText('となりのテーブルを通して、ここまでつながります。orgs')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(tour).toBeHidden()
      })
    })
  })
}

// Recorded in real time (as long as the presentation plays), so on one server only: the video does not read the DB.
test.describe('table presentation as a video', () => {
  const t = TARGETS[0]
  test('records the presentation with its words on it, and stops by hand', async ({ page }) => {
    test.skip(!t, 'no server to present')
    if (!t) return
    test.setTimeout(90_000)
    await login(page, t)
    await withScratchSpace(page, t, async (space) => {
      await sqlOn(page, space, 'CREATE TABLE solo (id INT PRIMARY KEY)')
      await page.goto(tableUrl(space, 'solo', '/overview'))
      await page.getByRole('button', { name: 'プレゼンで見る' }).click()
      const tour = page.getByRole('dialog', { name: 'テーブルのプレゼン: solo' })
      const record = tour.getByRole('button', { name: '動画で保存' })
      const stop = tour.getByRole('button', { name: '録画をやめる' })
      const recordable = await page.evaluate(
        () =>
          typeof MediaRecorder !== 'undefined' &&
          'captureStream' in HTMLCanvasElement.prototype &&
          ['video/mp4', 'video/webm'].some((type) => MediaRecorder.isTypeSupported(type))
      )
      // A browser that cannot record does not offer it.
      if (!recordable) {
        await expect(tour.getByRole('button', { name: 'HTML で保存' })).toBeVisible()
        await expect(record).toHaveCount(0)
        return
      }
      await expect(record).toHaveAttribute('title', /約 \d+ 秒/)
      // Stopped by hand: nothing is saved, and it can be recorded again.
      await record.click()
      await expect(tour.getByText(/^動画を録画しています（場面 1 \/ \d+/)).toBeVisible()
      await expect(record).toHaveAttribute('aria-disabled', 'true')
      await stop.click()
      await expect(stop).toHaveCount(0)
      await expect(tour.getByText('録画をやめました（動画は保存していません）')).toBeVisible()
      await expect(record).toBeFocused()
      await expect(record).not.toHaveAttribute('aria-disabled')

      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 75_000 }), record.click()])
      // WebKit on macOS hands the name decomposed (NFD).
      expect(download.suggestedFilename().normalize('NFC')).toMatch(/^テーブルのプレゼン_solo\.(mp4|webm)$/)
      const saved = test.info().outputPath(download.suggestedFilename())
      await download.saveAs(saved)
      expect(statSync(saved).size).toBeGreaterThan(1000)
      await expect(tour.getByText('動画を保存しました')).toBeVisible()
    })
  })
})
