import { expect } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, TARGETS, test } from './helpers.ts'
import { trialPlan } from './plan.ts'
import { pageProblems } from './scan.ts'

// Indexes the planner assumes are PostgreSQL's (HypoPG, installed on the test server); MySQL's estimate offers none.
for (const t of TARGETS) {
  test.describe(`an index tried without building it (${t.dialect})`, () => {
    test('plans as if the suggested index were there, on the estimate, and goes back', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await login(page, t)
      const table = scratchName('e2e_hypo')
      await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, level INT NOT NULL)`)
      try {
        const values = Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${i % 50})`).join(', ')
        await sqlOn(page, t, `INSERT INTO ${table} (id, level) VALUES ${values}`)
        // Two browsers on one database may make it at once: the loser's duplicate is not a failure.
        if (t.dialect === 'postgres') {
          await sqlOn(
            page,
            t,
            'DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS hypopg; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$'
          )
        }
        await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
        await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
        await page.keyboard.type(`SELECT id FROM ${table} WHERE level = 3`)
        await page.getByRole('button', { name: '図で見る', exact: true }).click()
        const plan = page.getByRole('region', { name: '実行計画', exact: true })
        await plan.getByRole('img', { name: '実行計画で読むテーブルの図' }).waitFor()
        const assume = plan.getByRole('region', { name: 'インデックスを作らずに試す（見込み）' })
        if (t.dialect === 'mysql') {
          await expect(assume).toHaveCount(0)
          return
        }
        await assume.getByRole('button', { name: `${table}（level）があるものとして見る` }).click()
        const index = `idx_${table}_level`
        await expect(assume.getByRole('status')).toHaveText(`${index} があるものとしての計画です（見込み）`)
        // Whether the server would read through it on so few rows is its own; that the estimates are set side by side
        // is not. Before, the table has its primary key only, so a condition on level is read in full on any version.
        await expect(assume.getByText(/^見込みのコスト: /)).toBeVisible()
        await expect(assume.getByRole('listitem').filter({ hasText: new RegExp(`^${table}: 全件 `) })).toHaveCount(1)
        // Nothing was built: the table has its primary key only, and the measuring is still to be asked for.
        await expect(plan.getByRole('button', { name: '実際に実行して測る' })).toBeVisible()
        const problems = await pageProblems(page)
        expect(problems.axe, JSON.stringify(problems.axe, null, 2)).toEqual([])
        expect(problems.layout, 'layout').toEqual([])
        // The presentation tells it as an estimate, and ends beside the plan as it is (whether the server would use
        // the index on so few rows is its own).
        await plan.getByRole('button', { name: 'プレゼンで見る' }).click()
        const tour = page.getByRole('dialog', { name: '実行計画のプレゼン' })
        await expect(tour.getByText(`インデックス ${index} があるものとして、`, { exact: false })).toBeVisible()
        await tour.getByRole('button', { name: /^\d+\. いまの計画（見込み）$/ }).click()
        await expect(tour.getByText(/第 \d+ 章「インデックスがあるものとした見込み」/)).toBeVisible()
        await expect(tour.getByText(new RegExp(`^いまの ${table} の読み方の見込み: 全件`))).toBeVisible()
        await tour.getByRole('button', { name: '次へ' }).click()
        await tour.getByRole('button', { name: '次へ' }).click()
        await expect(tour.getByRole('heading', { level: 3 })).toHaveText('見込みのコストを比べる')
        await expect(tour.getByText(/^見込みのコスト: /)).toBeVisible()
        await tour.getByRole('button', { name: '閉じる' }).click()
        await assume.getByRole('button', { name: '元の計画に戻す' }).click()
        await expect(assume.getByRole('status')).toHaveText('')
      } finally {
        await cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
      }
    })

    test('builds the index tried without building it, and sets the run beside the forecast', async ({ page }) => {
      test.skip(t.dialect !== 'postgres', 'HypoPG is PostgreSQL only')
      await login(page, t)
      await sqlOn(
        page,
        t,
        'DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS hypopg; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$'
      )
      // The trial's own steps log in again.
      await page.context().clearCookies()
      const { plan, trial, table, index, drop } = await trialPlan(page, t)
      try {
        const assume = plan.getByRole('region', { name: 'インデックスを作らずに試す（見込み）' })
        await assume.getByRole('button', { name: `${table}（level）があるものとして見る` }).click()
        await expect(assume.getByRole('status')).toHaveText(`${index} があるものとしての計画です（見込み）`)
        await assume.getByRole('button', { name: `${table}（level）を本当に作って測る` }).click()
        const make = page.getByRole('dialog', { name: 'インデックスを追加' })
        await expect(make).toContainText(index)
        await make.getByRole('button', { name: '実行する' }).click()
        await expect(trial.getByRole('status').filter({ hasText: `${index} を作って測り直しました` })).toBeVisible()
        // Whether the server used it on so few rows, as said or not, is its own: that the two are set side by side is not.
        await expect(trial.getByText(/^作る前の見込み（作らずに試した結果）: コスト /)).toBeVisible()
        await expect(trial.getByText(/^見込み(どおり|では)/)).toBeVisible()
        await plan.getByRole('button', { name: 'プレゼンで見る' }).click()
        const tour = page.getByRole('dialog', { name: '実行計画のプレゼン' })
        await tour.getByRole('button', { name: /^\d+\. 作る前の見込みと比べる$/ }).click()
        await expect(tour.getByRole('heading', { level: 3 })).toHaveText('作る前の見込みと比べる')
        await tour.getByRole('button', { name: '閉じる' }).click()
      } finally {
        await drop()
      }
    })
  })
}
