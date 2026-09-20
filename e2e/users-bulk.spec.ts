import { expect } from '@playwright/test'
import { confirmPreview, login, TARGETS, test } from './helpers.ts'

for (const t of TARGETS) {
  test.describe(`removing several users at once (${t.dialect})`, () => {
    test('ticks two accounts, revokes first, drops them (and a same-named database on MySQL)', async ({ page }) => {
      test.setTimeout(60_000)
      await login(page, t)
      const suffix = Date.now().toString(36)
      const names = [`e2e_bulk1_${suffix}`, `e2e_bulk2_${suffix}`]
      const mysql = t.dialect === 'mysql'
      const create = (name: string, own: boolean) =>
        page.request.post('/api/users/execute', {
          data: {
            op: {
              op: 'createUser',
              user: mysql ? { name, host: '%' } : { name },
              password: 'bulk-pw-1',
              attributes: { superuser: false, createdb: false, createrole: false },
              ...(mysql && own ? { createDatabase: true } : {}),
            },
          },
        })
      try {
        expect((await create(names[0] as string, true)).ok()).toBe(true)
        expect((await create(names[1] as string, false)).ok()).toBe(true)
        await page.goto('/users')
        for (const name of names) await page.getByLabel(mysql ? `${name}@% を選択` : `${name} を選択`).check()
        await expect(page.getByText('2 件のユーザーを選択中')).toBeVisible()
        await page.getByRole('button', { name: '選んだユーザーを削除…' }).click()
        const options = page.getByRole('dialog')
        await options.getByLabel(/先に権限を取り消す/).check()
        if (mysql) await options.getByLabel(/同じ名前のデータベースも削除する/).check()
        await options.getByRole('button', { name: '次へ（SQL を確認）' }).click()
        await confirmPreview(page, mysql ? /DROP USER[\s\S]*DROP DATABASE/ : /DROP OWNED[\s\S]*DROP ROLE/, t.host)
        for (const name of names) await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
        if (mysql) {
          const databases = await (await page.request.get('/api/databases')).json()
          expect((databases as { name: string }[]).map((d) => d.name)).not.toContain(names[0])
        }
      } finally {
        for (const name of names)
          await page.request.post('/api/users/execute', {
            data: { op: { op: 'dropUser', user: mysql ? { name, host: '%' } : { name } } },
          })
        // The database the first account was created with, if the run stopped before it was dropped.
        if (mysql)
          await page.request.post(`/api/databases/${t.database}/sql`, {
            data: { sql: `DROP DATABASE IF EXISTS \`${names[0]}\`` },
          })
      }
    })
  })
}
