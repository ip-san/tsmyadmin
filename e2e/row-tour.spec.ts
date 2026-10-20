import { expect } from '@playwright/test'
import { login, sqlOn, TARGETS, tableUrl, test, withScratchSpace } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`row tour (${t.dialect})`, () => {
    test('presents a row with the rows its keys join it to, and reads the design and where it may cost time', async ({
      page,
    }) => {
      test.setTimeout(60_000)
      await login(page, t)
      await withScratchSpace(page, t, async (space) => {
        // An order of a member, with two items that go with it (CASCADE); the member cannot go while ordered from.
        await sqlOn(page, space, 'CREATE TABLE members (id INT PRIMARY KEY, name VARCHAR(20))')
        await sqlOn(
          page,
          space,
          'CREATE TABLE orders (id INT PRIMARY KEY, member_id INT NOT NULL, FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE RESTRICT)'
        )
        await sqlOn(
          page,
          space,
          'CREATE TABLE items (id INT PRIMARY KEY, order_id INT NOT NULL, FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE)'
        )
        await sqlOn(page, space, "INSERT INTO members VALUES (1, 'alice')")
        await sqlOn(page, space, 'INSERT INTO orders VALUES (10, 1)')
        await sqlOn(page, space, 'INSERT INTO items VALUES (100, 10), (101, 10)')
        // Nothing plays by itself: the scenes are moved by hand.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(tableUrl(space, 'orders'))
        await page.getByLabel('1 行目を選択').check()
        await page.getByRole('button', { name: 'つながりをプレゼンで見る' }).click()

        const tour = page.getByRole('dialog', { name: /^行のつながりのプレゼン/ })
        const title = tour.getByRole('heading', { level: 3 })
        await expect(title).toHaveText('orders id=10')
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('members を参照')
        const notes = tour.getByRole('region', { name: '設計の読み取り' })
        await expect(notes).toContainText('orders は必ず members を指します（NOT NULL）')
        await expect(notes).toContainText('orders が指している members は消せません')
        await page.keyboard.press('ArrowRight')
        await expect(title).toHaveText('items から参照（2 行）')
        await expect(notes).toContainText('orders を消すと items も消えます（ON DELETE CASCADE）')
        await page.keyboard.press('End')
        await expect(title).toHaveText('まとめ')
        await expect(notes).toContainText('一緒に消える部分: orders の items')

        await page.keyboard.press('Escape')
        await expect(tour).toBeHidden()
      })
    })
  })
}
