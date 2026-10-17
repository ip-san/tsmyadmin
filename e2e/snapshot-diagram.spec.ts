import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`snapshot on the diagram (${t.dialect})`, () => {
    test('lays what changed since a snapshot over the designer, drawing what is gone', async ({ page }) => {
      test.setTimeout(90_000)
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        const run = (statement: string) => sqlOn(page, space, statement)
        const q = space.schema ? `?schema=${space.schema}` : ''
        await run('CREATE TABLE owners (id INT PRIMARY KEY)')
        await run('CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))')
        await run('CREATE TABLE items (id INT PRIMARY KEY)')
        await page.goto(`/db/${space.database}/snapshots${q}`)
        await page.getByLabel('名前', { exact: true }).fill('前')
        await page.getByRole('button', { name: 'スナップショットを取る' }).click()
        const list = page.getByRole('table', { name: '保存したスナップショット' })
        await expect(list.getByRole('cell', { name: '前', exact: true })).toBeVisible()

        // The "migration": pets is gone, items has a column more, later is new.
        await run('DROP TABLE pets; ALTER TABLE items ADD COLUMN note INT; CREATE TABLE later (id INT PRIMARY KEY)')
        await page.getByRole('button', { name: '前: 現在と比較' }).click()
        await page.getByRole('dialog').getByRole('button', { name: '図で見る' }).click()

        const panel = page.getByRole('region', { name: 'スナップショット「前」と比べています' })
        await expect(panel).toBeVisible()
        // What the colours say, by name.
        await expect(panel.getByText('追加: later')).toBeVisible()
        await expect(panel.getByText('削除: pets')).toBeVisible()
        await expect(panel.getByText('変更: items')).toBeVisible()
        const box = (name: string) => page.getByRole('button', { name: new RegExp(`^テーブル ${name}`) })
        await expect(box('later')).toHaveAttribute('data-tone', 'index')
        await expect(box('items')).toHaveAttribute('data-tone', 'nullify')
        // Drawn again, though it is gone, with the key it had.
        await expect(box('pets')).toHaveAttribute('data-tone', 'blocked')
        await expect(page.locator('figure g[data-tone="blocked"] path')).not.toHaveCount(0)
        await expect(box('owners')).not.toHaveAttribute('data-tone')
        // The other overlays would give the colours other meanings: off while comparing.
        await expect(page.getByRole('checkbox', { name: '使われ方を重ねる' })).toBeDisabled()
        await expect(page.getByRole('button', { name: '参照を検査' })).toBeDisabled()

        await page.getByRole('link', { name: '比べるのをやめる' }).click()
        await expect(box('pets')).toHaveCount(0)
        await expect(page.getByRole('checkbox', { name: '使われ方を重ねる' })).toBeEnabled()
      })
    })
  })
}
