import type { Page } from '@playwright/test'
import type { Target } from './helpers.ts'

/** A parent and a child whose key names two parents that are not there (the key was added unchecked). */
export async function orphanedKey(page: Page, t: Target) {
  const parent = `e2e_orph_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const child = `${parent}_c`
  const run = (sql: string) =>
    page.request.post(`/api/databases/${t.database}/sql`, { data: { sql, ...(t.schema ? { schema: t.schema } : {}) } })
  await run(`CREATE TABLE ${parent} (id INT PRIMARY KEY)`)
  await run(`CREATE TABLE ${child} (id INT PRIMARY KEY, pid INT)`)
  await run(`INSERT INTO ${parent} VALUES (1)`)
  await run(`INSERT INTO ${child} VALUES (1, 1), (2, 7), (3, 8), (4, NULL)`)
  await run(
    t.dialect === 'mysql'
      ? `SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id)`
      : `ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id) NOT VALID`
  )
  return {
    key: `${child}_fk`,
    async drop() {
      await run(`DROP TABLE IF EXISTS ${child}`)
      await run(`DROP TABLE IF EXISTS ${parent}`)
    },
  }
}
