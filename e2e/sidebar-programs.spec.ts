import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

/**
 * The routines and events under a database in the sidebar (phpMyAdmin's tree has them): opt-in, a setting that is off
 * until it is switched on, and read only when a branch is opened.
 */
for (const t of TARGETS) {
  test.describe(`sidebar routines and events (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('shows them under the database once the setting is on, and opens one', async ({ page }) => {
      // MySQL lists the database; PostgreSQL lists its schemas under it.
      const node = t.dialect === 'mysql' ? t.database : (t.schema ?? 'public')
      const aside = page.locator('aside')
      const expand = aside.getByRole('button', { name: `${node} を展開 / 折りたたむ` })
      const url = `/db/${t.database}${t.schema ? `?schema=${t.schema}` : ''}`

      // Off by default: the database opens to its tables and nothing else.
      await page.goto(url)
      await expect(aside.getByRole('button', { name: 'ルーチン', exact: true })).toHaveCount(0)

      await page.goto('/settings')
      await page.getByLabel('サイドバーのデータベースの下に、ルーチンとイベントを出す').check()
      // Saved with the button, which then loads the page again: the sidebar reads the setting when it mounts.
      await page.getByRole('button', { name: '保存する' }).click()
      await expect(page.getByText('保存しました。')).toBeVisible()

      await page.goto(url)
      if ((await expand.getAttribute('aria-expanded')) !== 'true') await expand.click()
      const routines = aside.getByRole('button', { name: 'ルーチン', exact: true })
      await expect(routines).toHaveAttribute('aria-expanded', 'false')
      // Closed until opened, and read only then.
      await expect(aside.getByRole('link', { name: 'count_users', exact: true })).toHaveCount(0)
      await routines.click()
      await expect(routines).toHaveAttribute('aria-expanded', 'true')
      await expect(aside.getByRole('link', { name: 'count_users', exact: true })).toBeVisible()
      await expect(aside.getByRole('link', { name: 'user_label', exact: true })).toBeVisible()

      // MySQL also has events; PostgreSQL has none, so there is no such branch.
      const events = aside.getByRole('button', { name: 'イベント', exact: true })
      if (t.dialect === 'mysql') {
        await events.click()
        await expect(aside.getByRole('link', { name: 'purge_old_posts', exact: true })).toBeVisible()
      } else {
        await expect(events).toHaveCount(0)
      }

      // A name leads to the routines screen of that database.
      await aside.getByRole('link', { name: 'count_users', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/db/${t.database}/routines`))
    })
  })
}
