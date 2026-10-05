import { expect } from '@playwright/test'
import { test } from './helpers.ts'

/**
 * The router's error boundary: an unexpected failure while a page is being prepared (here the API answering 500 where
 * the session is asked for) shows the error screen with what went wrong, instead of a blank page, and "retry" asks
 * again. A 401 is not such a failure: it is the answer "not signed in", which sends the visitor to the login.
 */
test.describe('unexpected errors', () => {
  test('show the error screen with the reason, and retry recovers once the server answers again', async ({ page }) => {
    let failing = true
    await page.route('**/api/session', async (route) => {
      if (failing && route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL', message: 'the server fell over' }),
        })
      } else {
        await route.continue()
      }
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: '画面の表示中にエラーが発生しました' })).toBeVisible()
    // The reason is on the screen in the app's own words (not what the server said: an internal error shows no
    // internal detail), and the way out is offered: reload, back to the top, and retry.
    await expect(page.getByRole('alert')).toContainText('内部エラーが発生しました')
    await expect(page.getByRole('alert')).not.toContainText('the server fell over')
    await expect(page.getByRole('button', { name: '再読み込み' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'トップへ戻る' })).toBeVisible()

    // The server answers again (nobody is signed in: a 401, which is an ordinary "go and log in").
    failing = false
    await page.getByRole('button', { name: '再試行' }).click()
    await expect(page).toHaveURL(/\/login/)
  })
})
